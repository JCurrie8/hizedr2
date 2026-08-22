-- Link an approved SQL workbench transformation to a separate read-only SQL
-- source pipeline and schedule its governed publication into Hized.

create table public.pipeline_sql_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transformation_id uuid not null,
  pipeline_id uuid not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  schedule_enabled boolean not null default false,
  schedule_interval_minutes integer not null default 60
    check (schedule_interval_minutes in (60, 180, 360, 720, 1440)),
  next_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_retry_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (transformation_id),
  unique (pipeline_id),
  foreign key (transformation_id, tenant_id)
    references public.pipeline_sql_transformation_versions(id, tenant_id) on delete restrict,
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade,
  check ((schedule_enabled and next_sync_at is not null) or (not schedule_enabled and next_sync_at is null)),
  check ((lease_token is null and lease_expires_at is null) or (lease_token is not null and lease_expires_at is not null))
);

create index pipeline_sql_publications_tenant_idx
  on public.pipeline_sql_publications (tenant_id, transformation_id);
create index pipeline_sql_publications_due_idx
  on public.pipeline_sql_publications (next_sync_at, id)
  where schedule_enabled and status = 'active';

-- Enforce the cross-stage hand-off even for a direct app-role write. The
-- publisher must target the exact approved object and complete field signature
-- through a different read-only credential for the same server/database.
create function public.validate_pipeline_sql_publication()
returns trigger language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_transformation public.pipeline_sql_transformation_versions%rowtype;
  v_destination public.pipeline_sql_destinations%rowtype;
  v_pipeline public.pipelines%rowtype;
  v_source public.connectors%rowtype;
  v_loader public.connectors%rowtype;
  v_fields jsonb;
begin
  select transformation.* into v_transformation
    from public.pipeline_sql_transformation_versions transformation
   where transformation.id = new.transformation_id
     and transformation.tenant_id = new.tenant_id;
  if not found or v_transformation.status <> 'approved' then
    raise exception 'Publication requires the currently approved SQL transformation.';
  end if;
  select destination.* into v_destination
    from public.pipeline_sql_destinations destination
   where destination.id = v_transformation.destination_id
     and destination.tenant_id = new.tenant_id;
  select pipeline.* into v_pipeline
    from public.pipelines pipeline
   where pipeline.id = new.pipeline_id and pipeline.tenant_id = new.tenant_id;
  if not found or v_pipeline.status <> 'active' or v_pipeline.load_mode <> 'snapshot' then
    raise exception 'Publication requires an active snapshot SQL source pipeline.';
  end if;
  select connector.* into v_source from public.connectors connector
   where connector.id = v_pipeline.connector_id and connector.tenant_id = new.tenant_id;
  select connector.* into v_loader from public.connectors connector
   where connector.id = v_destination.connector_id and connector.tenant_id = new.tenant_id;
  if v_source.id is null
     or v_source.id = v_loader.id
     or v_source.connector_type not in ('sql_server', 'azure_sql')
     or coalesce(v_source.config ->> 'direction', 'source') <> 'source'
     or v_source.status not in ('active', 'error')
     or lower(v_source.config ->> 'server') is distinct from lower(v_loader.config ->> 'server')
     or lower(v_source.config ->> 'database') is distinct from lower(v_loader.config ->> 'database')
     or coalesce(v_source.config ->> 'port', '1433') is distinct from coalesce(v_loader.config ->> 'port', '1433') then
    raise exception 'Publication requires a separate read-only connection to the same SQL database.';
  end if;
  select jsonb_agg(field -> 'name' order by position)
    into v_fields
    from jsonb_array_elements(v_transformation.column_signature) with ordinality item(field, position);
  if v_pipeline.source_config ->> 'approvedTransformationId' is distinct from v_transformation.id::text
     or lower(v_pipeline.source_config ->> 'schema') is distinct from lower(v_transformation.object_schema)
     or lower(v_pipeline.source_config ->> 'object') is distinct from lower(v_transformation.object_name)
     or v_pipeline.source_config ->> 'objectType' is distinct from v_transformation.object_type
     or v_pipeline.source_config -> 'fields' is distinct from v_fields then
    raise exception 'The SQL source pipeline does not match the approved transformation signature.';
  end if;
  return new;
end;
$$;

create trigger validate_pipeline_sql_publication_before_write
before insert or update of tenant_id, transformation_id, pipeline_id
on public.pipeline_sql_publications
for each row execute function public.validate_pipeline_sql_publication();

alter table public.pipeline_sql_publications enable row level security;
create policy "SQL publications: scoped operator reads"
on public.pipeline_sql_publications for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);
create policy "SQL publications: scoped operator inserts"
on public.pipeline_sql_publications for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);
create policy "SQL publications: scoped operator updates"
on public.pipeline_sql_publications for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);

create function public.protect_pipeline_sql_publication_identity()
returns trigger language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if old.tenant_id is distinct from new.tenant_id
     or old.transformation_id is distinct from new.transformation_id
     or old.pipeline_id is distinct from new.pipeline_id
     or old.created_by is distinct from new.created_by
     or old.created_at is distinct from new.created_at then
    raise exception 'An approved SQL publication binding is immutable.';
  end if;
  return new;
end;
$$;
create trigger protect_pipeline_sql_publication_identity_before_update
before update on public.pipeline_sql_publications
for each row execute function public.protect_pipeline_sql_publication_identity();

create function public.protect_approved_sql_publication_pipeline()
returns trigger language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.pipeline_sql_publications publication
     where publication.pipeline_id = old.id and publication.tenant_id = old.tenant_id
  ) then
    if tg_op = 'DELETE' then
      if public.current_user_id() is not null then
        raise exception 'An approved SQL publication pipeline cannot be deleted.';
      end if;
      return old;
    end if;
    if old.tenant_id is distinct from new.tenant_id
       or old.connector_id is distinct from new.connector_id
       or old.source_config is distinct from new.source_config
       or old.load_mode is distinct from new.load_mode
       or old.key_columns is distinct from new.key_columns
       or old.status is distinct from new.status then
      raise exception 'An approved SQL publication pipeline cannot be repointed or disabled.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger protect_approved_sql_publication_pipeline_before_write
before update or delete on public.pipelines
for each row execute function public.protect_approved_sql_publication_pipeline();

create function public.protect_approved_sql_publication_mappings()
returns trigger language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_pipeline_id uuid;
  v_tenant_id uuid;
begin
  if tg_op in ('DELETE', 'UPDATE') then
    v_pipeline_id := old.pipeline_id;
    v_tenant_id := old.tenant_id;
  else
    v_pipeline_id := new.pipeline_id;
    v_tenant_id := new.tenant_id;
  end if;
  if exists (
    select 1 from public.pipeline_sql_publications publication
     where publication.pipeline_id = v_pipeline_id
       and publication.tenant_id = v_tenant_id
  ) then
    raise exception 'Approved SQL publication field mappings are immutable.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger protect_approved_sql_publication_mappings_before_write
before insert or update or delete on public.pipeline_field_mappings
for each row execute function public.protect_approved_sql_publication_mappings();

create function public.claim_due_sql_publication_syncs(p_limit integer default 5)
returns table (tenant_id uuid, connector_id uuid, pipeline_id uuid, publication_id uuid, actor_user_id uuid, lease_token uuid)
language sql volatile security definer
set search_path = ''
as $$
  with candidates as materialized (
    select publication.id, publication.tenant_id, publication.pipeline_id,
           pipeline.connector_id, operator.user_id as actor_user_id
      from public.pipeline_sql_publications publication
      join public.pipeline_sql_transformation_versions transformation
        on transformation.id = publication.transformation_id
       and transformation.tenant_id = publication.tenant_id
       and transformation.status = 'approved'
      join public.pipelines pipeline
        on pipeline.id = publication.pipeline_id
       and pipeline.tenant_id = publication.tenant_id and pipeline.status = 'active'
      join public.connectors connector
        on connector.id = pipeline.connector_id and connector.tenant_id = pipeline.tenant_id
       and connector.status in ('active', 'error')
       and coalesce(connector.config ->> 'direction', 'source') = 'source'
      join public.connector_credentials credential
        on credential.connector_id = connector.id and credential.tenant_id = connector.tenant_id
      join public.tenants tenant on tenant.id = publication.tenant_id and tenant.status = 'active'
      join public.tenant_product_entitlements entitlement
        on entitlement.tenant_id = publication.tenant_id
       and entitlement.product_key = 'connect' and entitlement.status in ('active', 'trial')
      join lateral (
        select membership.user_id from public.tenant_memberships membership
         where membership.tenant_id = publication.tenant_id
           and membership.status = 'active' and membership.role in ('company_admin', 'analyst')
         order by (membership.user_id = publication.created_by) desc, membership.created_at, membership.user_id
         limit 1
      ) operator on true
     where publication.status = 'active' and publication.schedule_enabled
       and publication.next_sync_at <= clock_timestamp()
       and (publication.next_retry_at is null or publication.next_retry_at <= clock_timestamp())
       and (publication.lease_expires_at is null or publication.lease_expires_at <= clock_timestamp())
     order by publication.next_sync_at, publication.id
     for update of publication skip locked
     limit least(greatest(coalesce(p_limit, 5), 1), 20)
  ), leased as (
    update public.pipeline_sql_publications publication
       set lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '15 minutes',
           last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
      from candidates candidate
     where publication.id = candidate.id and publication.tenant_id = candidate.tenant_id
    returning publication.id, publication.tenant_id, publication.pipeline_id, publication.lease_token
  )
  select leased.tenant_id, candidate.connector_id, leased.pipeline_id, leased.id,
         candidate.actor_user_id, leased.lease_token
    from leased join candidates candidate on candidate.id = leased.id and candidate.tenant_id = leased.tenant_id
$$;

revoke execute on function public.validate_pipeline_sql_publication() from public;
revoke execute on function public.protect_pipeline_sql_publication_identity() from public;
revoke execute on function public.protect_approved_sql_publication_pipeline() from public;
revoke execute on function public.protect_approved_sql_publication_mappings() from public;
revoke execute on function public.claim_due_sql_publication_syncs(integer) from public;
grant execute on function public.validate_pipeline_sql_publication() to app_user;
grant execute on function public.protect_pipeline_sql_publication_identity() to app_user;
grant execute on function public.protect_approved_sql_publication_pipeline() to app_user;
grant execute on function public.protect_approved_sql_publication_mappings() to app_user;
grant execute on function public.claim_due_sql_publication_syncs(integer) to app_user;
