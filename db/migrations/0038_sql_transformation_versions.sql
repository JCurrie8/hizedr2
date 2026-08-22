-- Govern the hand-off from a successfully loaded SQL landing table to one
-- explicitly validated and Company Admin-approved analytical table or view.
-- Hized records identity, column signature and promotion history; it does not
-- execute arbitrary customer-authored SQL.

create table public.pipeline_sql_transformation_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  destination_id uuid not null,
  version_number integer not null check (version_number > 0),
  object_schema text not null check (object_schema ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  object_name text not null check (object_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  object_type text not null check (object_type in ('table', 'view')),
  column_signature jsonb not null check (
    jsonb_typeof(column_signature) = 'array'
    and jsonb_array_length(column_signature) between 1 and 250
  ),
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  change_note text not null check (char_length(change_note) between 1 and 500),
  validated_at timestamptz not null,
  created_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (destination_id, version_number),
  foreign key (destination_id, tenant_id)
    references public.pipeline_sql_destinations(id, tenant_id) on delete cascade,
  check (
    (status = 'draft' and approved_by is null and approved_at is null)
    or (status in ('approved', 'superseded') and approved_by is not null and approved_at is not null)
  )
);

create unique index pipeline_sql_transformation_versions_one_approved_idx
  on public.pipeline_sql_transformation_versions (destination_id)
  where status = 'approved';
create index pipeline_sql_transformation_versions_tenant_destination_idx
  on public.pipeline_sql_transformation_versions
    (tenant_id, destination_id, version_number desc);

alter table public.pipeline_sql_transformation_versions enable row level security;

create policy "pipeline SQL transformations: scoped operator reads"
on public.pipeline_sql_transformation_versions for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);

-- A controlled function assigns the next version while holding the destination
-- lock. app_user has no direct INSERT/UPDATE/DELETE grant on the table.
create function public.create_sql_transformation_version(
  p_tenant_id uuid,
  p_destination_id uuid,
  p_object_schema text,
  p_object_name text,
  p_object_type text,
  p_column_signature jsonb,
  p_change_note text,
  p_actor_user_id uuid
)
returns table (id uuid, version_number integer)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_destination public.pipeline_sql_destinations%rowtype;
  v_version integer;
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or p_actor_user_id is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not public.is_connect_operator(p_tenant_id) then
    raise exception 'The selected tenant or Connect operator is not authorised.';
  end if;
  if coalesce(p_object_schema ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$', false) is not true
     or coalesce(p_object_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$', false) is not true
     or coalesce(p_object_type in ('table', 'view'), false) is not true
     or jsonb_typeof(p_column_signature) is distinct from 'array'
     or coalesce(char_length(btrim(p_change_note)) between 1 and 500, false) is not true then
    raise exception 'The validated SQL transformation definition is invalid.';
  end if;
  if jsonb_array_length(p_column_signature) not between 1 and 250 then
    raise exception 'The validated SQL transformation definition is invalid.';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_column_signature) field
     where jsonb_typeof(field) is distinct from 'object'
        or jsonb_typeof(field -> 'name') is distinct from 'string'
        or coalesce(char_length(field ->> 'name') between 1 and 128, false) is not true
        or jsonb_typeof(field -> 'sqlType') is distinct from 'string'
        or coalesce(char_length(field ->> 'sqlType') between 1 and 128, false) is not true
        or coalesce(field ->> 'dataType' in ('string', 'integer', 'numeric', 'boolean', 'date', 'timestamp'), false) is not true
        or jsonb_typeof(field -> 'nullable') is distinct from 'boolean'
        or jsonb_typeof(field -> 'primaryKey') is distinct from 'boolean'
  ) or exists (
    select 1
      from jsonb_array_elements(p_column_signature) field
     group by lower(field ->> 'name')
    having count(*) > 1
  ) then
    raise exception 'The validated SQL transformation column signature is invalid.';
  end if;

  select destination.* into v_destination
    from public.pipeline_sql_destinations destination
   where destination.id = p_destination_id
     and destination.tenant_id = p_tenant_id
     and destination.status = 'active'
   for update;
  if not found then
    raise exception 'The SQL workbench destination is unavailable.';
  end if;
  if lower(v_destination.target_schema) <> lower(p_object_schema)
     or lower(v_destination.target_table) = lower(p_object_name) then
    raise exception 'Register a transformed object in the managed schema, not the landing table itself.';
  end if;
  if not exists (
    select 1 from public.pipeline_sql_destination_runs run
     where run.destination_id = v_destination.id
       and run.tenant_id = p_tenant_id
       and run.status = 'succeeded'
  ) then
    raise exception 'Load the validated source into SQL before registering a transformation.';
  end if;

  select coalesce(max(transformation.version_number), 0) + 1
    into v_version
    from public.pipeline_sql_transformation_versions transformation
   where transformation.destination_id = v_destination.id
     and transformation.tenant_id = p_tenant_id;

  return query
  insert into public.pipeline_sql_transformation_versions
    (tenant_id, destination_id, version_number, object_schema, object_name,
     object_type, column_signature, change_note, validated_at, created_by)
  values
    (p_tenant_id, v_destination.id, v_version, p_object_schema, p_object_name,
     p_object_type, p_column_signature, btrim(p_change_note), now(), p_actor_user_id)
  returning pipeline_sql_transformation_versions.id,
            pipeline_sql_transformation_versions.version_number;
end;
$$;

-- Promotion is the only update path. It requires the selected-tenant Company
-- Admin, refuses stale drafts and atomically supersedes the previous approval.
create function public.approve_sql_transformation_version(
  p_tenant_id uuid,
  p_transformation_id uuid,
  p_actor_user_id uuid
)
returns table (id uuid, destination_id uuid, version_number integer)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_transformation public.pipeline_sql_transformation_versions%rowtype;
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or p_actor_user_id is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not public.is_company_admin(p_tenant_id) then
    raise exception 'Only a Company Admin can approve a SQL transformation.';
  end if;

  select transformation.* into v_transformation
    from public.pipeline_sql_transformation_versions transformation
   where transformation.id = p_transformation_id
     and transformation.tenant_id = p_tenant_id
   for update;
  if not found or v_transformation.status <> 'draft' then
    raise exception 'The draft SQL transformation is unavailable.';
  end if;
  perform 1 from public.pipeline_sql_destinations destination
   where destination.id = v_transformation.destination_id
     and destination.tenant_id = p_tenant_id
     and destination.status = 'active'
   for update;
  if not found then
    raise exception 'The SQL workbench destination is unavailable.';
  end if;
  if exists (
    select 1 from public.pipeline_sql_transformation_versions newer
     where newer.destination_id = v_transformation.destination_id
       and newer.tenant_id = p_tenant_id
       and newer.status = 'draft'
       and newer.version_number > v_transformation.version_number
  ) then
    raise exception 'Only the latest validated transformation draft can be approved.';
  end if;

  update public.pipeline_sql_transformation_versions current
     set status = 'superseded'
   where current.destination_id = v_transformation.destination_id
     and current.tenant_id = p_tenant_id
     and current.status = 'approved';

  return query
  update public.pipeline_sql_transformation_versions promoted
     set status = 'approved', approved_by = p_actor_user_id, approved_at = now()
   where promoted.id = v_transformation.id
     and promoted.tenant_id = p_tenant_id
  returning promoted.id, promoted.destination_id, promoted.version_number;
end;
$$;

revoke all on table public.pipeline_sql_transformation_versions from public;
revoke insert, update, delete, truncate, references, trigger
  on table public.pipeline_sql_transformation_versions from app_user;
grant select on table public.pipeline_sql_transformation_versions to app_user;

revoke execute on function public.create_sql_transformation_version(uuid, uuid, text, text, text, jsonb, text, uuid) from public;
revoke execute on function public.approve_sql_transformation_version(uuid, uuid, uuid) from public;
grant execute on function public.create_sql_transformation_version(uuid, uuid, text, text, text, jsonb, text, uuid) to app_user;
grant execute on function public.approve_sql_transformation_version(uuid, uuid, uuid) to app_user;
