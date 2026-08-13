-- EPIC-06/07: tenant-governed dimensions, validated KPI slices, and a
-- deliberately projected source-record lineage boundary for Pulse/Canvas.
-- Curated Connect records retain their operator-only RLS policy: end users
-- can see only explicitly approved, non-sensitive projected fields.

create table public.governed_dimensions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dimension_key text not null check (dimension_key ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '',
  semantic_type text not null default 'custom'
    check (semantic_type in ('product', 'customer', 'geography', 'organisation', 'custom')),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dimension_key),
  unique (id, tenant_id)
);

create table public.governed_dimension_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dimension_id uuid not null,
  member_key text not null check (length(trim(member_key)) between 1 and 160),
  label text not null check (length(trim(label)) between 1 and 160),
  description text not null default '',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dimension_id, member_key),
  unique (id, tenant_id),
  foreign key (dimension_id, tenant_id)
    references public.governed_dimensions(id, tenant_id) on delete cascade
);

create table public.kpi_definition_dimensions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kpi_definition_id uuid not null,
  dimension_id uuid not null,
  is_filterable boolean not null default true,
  is_drillable boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, kpi_definition_id, dimension_id),
  foreign key (kpi_definition_id, tenant_id)
    references public.kpi_definitions(id, tenant_id) on delete cascade,
  foreign key (dimension_id, tenant_id)
    references public.governed_dimensions(id, tenant_id) on delete restrict
);

alter table public.kpi_values
  add column dimension_slice jsonb not null default '{}'::jsonb
    check (jsonb_typeof(dimension_slice) = 'object');

do $$
declare
  existing_constraint text;
begin
  select constraint_name into existing_constraint
    from information_schema.table_constraints
   where table_schema = 'public'
     and table_name = 'kpi_values'
     and constraint_type = 'UNIQUE'
     and constraint_name <> 'kpi_values_slice_unique'
   order by constraint_name
   limit 1;

  if existing_constraint is not null then
    execute format('alter table public.kpi_values drop constraint %I', existing_constraint);
  end if;
end
$$;

alter table public.kpi_values
  add constraint kpi_values_slice_unique unique
    (tenant_id, kpi_definition_id, org_node_id, period_start, period_end, dimension_slice);

alter table public.kpi_values
  add constraint kpi_values_id_tenant_unique unique (id, tenant_id);

create index governed_dimensions_tenant_status_idx
  on public.governed_dimensions (tenant_id, status, dimension_key);
create index governed_dimension_members_dimension_idx
  on public.governed_dimension_members (tenant_id, dimension_id, is_active, sort_order, label);
create index kpi_definition_dimensions_dimension_idx
  on public.kpi_definition_dimensions (tenant_id, dimension_id, kpi_definition_id);
create index kpi_values_dimension_slice_idx
  on public.kpi_values using gin (dimension_slice jsonb_path_ops)
  where dimension_slice <> '{}'::jsonb;

create or replace function public.validate_kpi_dimension_slice()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.dimension_slice = '{}'::jsonb then
    return new;
  end if;

  if exists (
    select 1 from jsonb_each(new.dimension_slice) entry
    where jsonb_typeof(entry.value) <> 'string'
  ) then
    raise exception 'KPI dimension slice values must be member keys';
  end if;

  if exists (
    select 1
      from jsonb_each_text(new.dimension_slice) entry
     where not exists (
       select 1
         from public.kpi_definition_dimensions link
         join public.governed_dimensions dimension
           on dimension.id = link.dimension_id
          and dimension.tenant_id = link.tenant_id
         join public.governed_dimension_members member
           on member.dimension_id = dimension.id
          and member.tenant_id = dimension.tenant_id
          and member.member_key = entry.value
          and member.is_active
        where link.tenant_id = new.tenant_id
          and link.kpi_definition_id = new.kpi_definition_id
          and dimension.dimension_key = entry.key
          and dimension.status = 'published'
     )
  ) then
    raise exception 'KPI dimension slice contains an ungoverned dimension or member';
  end if;

  return new;
end
$$;

create trigger validate_kpi_dimension_slice_before_write
before insert or update of tenant_id, kpi_definition_id, dimension_slice
on public.kpi_values
for each row execute function public.validate_kpi_dimension_slice();

-- This table is the only source-record shape readable outside Connect. The
-- projection validator rejects keys that are absent from the governed field
-- catalogue or marked sensitive, so raw curated JSON never crosses the gate.
create table public.governed_record_projections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dataset_id uuid not null,
  source_record_id uuid not null,
  org_node_id uuid not null,
  occurred_at timestamptz,
  display_data jsonb not null check (jsonb_typeof(display_data) = 'object'),
  source_refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, dataset_id, source_record_id, org_node_id),
  foreign key (dataset_id, tenant_id)
    references public.governed_datasets(id, tenant_id) on delete cascade,
  foreign key (source_record_id, tenant_id)
    references public.curated_records(id, tenant_id) on delete cascade,
  foreign key (org_node_id, tenant_id)
    references public.org_nodes(id, tenant_id) on delete restrict
);

create table public.kpi_value_record_lineage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kpi_value_id uuid not null,
  projection_id uuid not null,
  contribution_value numeric,
  created_at timestamptz not null default now(),
  primary key (tenant_id, kpi_value_id, projection_id),
  foreign key (kpi_value_id, tenant_id)
    references public.kpi_values(id, tenant_id) on delete cascade,
  foreign key (projection_id, tenant_id)
    references public.governed_record_projections(id, tenant_id) on delete cascade
);

create index governed_record_projections_dataset_idx
  on public.governed_record_projections (tenant_id, dataset_id, occurred_at desc);
create index governed_record_projections_source_idx
  on public.governed_record_projections (tenant_id, source_record_id);
create index governed_record_projections_org_idx
  on public.governed_record_projections (tenant_id, org_node_id, occurred_at desc);
create index kpi_value_record_lineage_projection_idx
  on public.kpi_value_record_lineage (tenant_id, projection_id, kpi_value_id);

create or replace function public.validate_governed_record_projection()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.governed_datasets dataset
      join public.curated_records record
        on record.pipeline_id = dataset.source_pipeline_id
       and record.tenant_id = dataset.tenant_id
     where dataset.id = new.dataset_id
       and dataset.tenant_id = new.tenant_id
       and record.id = new.source_record_id
       and not record.is_deleted
  ) then
    raise exception 'Projection source must belong to the governed dataset pipeline';
  end if;

  if exists (
    select 1
      from jsonb_object_keys(new.display_data) projected(field_key)
     where not exists (
       select 1
         from public.governed_dataset_fields field
        where field.tenant_id = new.tenant_id
          and field.dataset_id = new.dataset_id
          and field.field_key = projected.field_key
          and not field.is_sensitive
     )
  ) then
    raise exception 'Projection contains an unknown or sensitive field';
  end if;

  return new;
end
$$;

create trigger validate_governed_record_projection_before_write
before insert or update of tenant_id, dataset_id, source_record_id, display_data
on public.governed_record_projections
for each row execute function public.validate_governed_record_projection();

create or replace function public.can_read_governed_dimension(
  p_tenant_id uuid,
  p_dimension_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
        from public.governed_dimensions dimension
       where dimension.id = p_dimension_id
         and dimension.tenant_id = p_tenant_id
         and (
           dimension.status = 'published'
           or public.is_kpi_governor(p_tenant_id)
           or public.is_platform_admin()
         )
    )
$$;

create or replace function public.can_read_kpi_value_lineage(
  p_tenant_id uuid,
  p_kpi_value_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
        from public.kpi_values value
       where value.id = p_kpi_value_id
         and value.tenant_id = p_tenant_id
         and public.can_read_kpi_value(
           value.tenant_id,
           value.kpi_definition_id,
           value.org_node_id
         )
    )
$$;

create or replace function public.can_read_governed_record_projection(
  p_tenant_id uuid,
  p_projection_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
        from public.kpi_value_record_lineage lineage
       where lineage.tenant_id = p_tenant_id
         and lineage.projection_id = p_projection_id
         and public.can_read_kpi_value_lineage(p_tenant_id, lineage.kpi_value_id)
    )
$$;

alter table public.governed_dimensions enable row level security;
alter table public.governed_dimension_members enable row level security;
alter table public.kpi_definition_dimensions enable row level security;
alter table public.governed_record_projections enable row level security;
alter table public.kpi_value_record_lineage enable row level security;

create policy "governed dimensions: permitted reads"
on public.governed_dimensions for select
using (public.can_read_governed_dimension(tenant_id, id));

create policy "governed dimensions: selected tenant governor inserts"
on public.governed_dimensions for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
);

create policy "governed dimensions: selected tenant governor updates"
on public.governed_dimensions for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and updated_by = public.current_user_id()
);

create policy "governed dimensions: selected tenant governor deletes"
on public.governed_dimensions for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "governed dimension members: permitted reads"
on public.governed_dimension_members for select
using (
  tenant_id = public.current_tenant_id()
  and public.can_read_governed_dimension(tenant_id, dimension_id)
);

create policy "governed dimension members: selected tenant governor writes"
on public.governed_dimension_members for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "KPI dimensions: permitted reads"
on public.kpi_definition_dimensions for select
using (
  tenant_id = public.current_tenant_id()
  and public.can_read_kpi_definition(tenant_id, kpi_definition_id)
  and public.can_read_governed_dimension(tenant_id, dimension_id)
);

create policy "KPI dimensions: selected tenant governor writes"
on public.kpi_definition_dimensions for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "governed record projections: lineage-scoped reads"
on public.governed_record_projections for select
using (
  tenant_id = public.current_tenant_id()
  and public.can_read_governed_record_projection(tenant_id, id)
);

create policy "governed record projections: selected tenant governor writes"
on public.governed_record_projections for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "KPI record lineage: hierarchy-scoped reads"
on public.kpi_value_record_lineage for select
using (
  tenant_id = public.current_tenant_id()
  and public.can_read_kpi_value_lineage(tenant_id, kpi_value_id)
);

create policy "KPI record lineage: selected tenant governor writes"
on public.kpi_value_record_lineage for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

revoke execute on function public.validate_kpi_dimension_slice() from public;
revoke execute on function public.validate_governed_record_projection() from public;
revoke execute on function public.can_read_governed_dimension(uuid, uuid) from public;
revoke execute on function public.can_read_kpi_value_lineage(uuid, uuid) from public;
revoke execute on function public.can_read_governed_record_projection(uuid, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.can_read_governed_dimension(uuid, uuid) to app_user';
    execute 'grant execute on function public.can_read_kpi_value_lineage(uuid, uuid) to app_user';
    execute 'grant execute on function public.can_read_governed_record_projection(uuid, uuid) to app_user';
  end if;
end
$$;
