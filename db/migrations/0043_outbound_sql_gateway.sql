-- Outbound-only Windows gateway for private SQL Server installations. Device
-- credentials and SQL credentials never share a trust boundary: Hized stores
-- only token hashes, while the Windows host retains its SQL secret locally.

alter table public.sql_analysis_queries
  drop constraint if exists sql_analysis_queries_last_run_status_check;
alter table public.sql_analysis_queries
  add constraint sql_analysis_queries_last_run_status_check
  check (last_run_status is null or last_run_status in ('queued', 'succeeded', 'failed'));

create table public.connector_gateways (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  connector_name text not null check (length(trim(connector_name)) between 2 and 120),
  status text not null default 'pending'
    check (status in ('pending', 'enrolling', 'active', 'error', 'revoked')),
  enrollment_token_hash text not null unique
    check (enrollment_token_hash ~ '^[0-9a-f]{64}$'),
  enrollment_expires_at timestamptz not null,
  enrolled_at timestamptz,
  device_token_hash text unique
    check (device_token_hash is null or device_token_hash ~ '^[0-9a-f]{64}$'),
  connector_id uuid references public.connectors(id) on delete set null,
  installation_id uuid,
  machine_name text check (machine_name is null or length(machine_name) between 1 and 160),
  platform text check (platform is null or length(platform) between 1 and 120),
  worker_version text check (worker_version is null or length(worker_version) between 1 and 40),
  protocol_version integer check (protocol_version is null or protocol_version > 0),
  capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities) = 'object'),
  last_seen_at timestamptz,
  last_error text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (connector_id),
  check (enrollment_expires_at <= created_at + interval '30 minutes')
);

create unique index connector_gateways_active_name_idx
  on public.connector_gateways (tenant_id, lower(name))
  where status <> 'revoked';
create index connector_gateways_tenant_status_idx
  on public.connector_gateways (tenant_id, status, updated_at desc);
create index connector_gateways_device_idx
  on public.connector_gateways (device_token_hash)
  where device_token_hash is not null and status = 'active';

create table public.connector_gateway_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  gateway_id uuid not null,
  connector_id uuid not null,
  query_id uuid not null,
  kind text not null check (kind = 'sql_analysis'),
  status text not null default 'queued'
    check (status in ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  actor_user_id uuid not null references public.profiles(id) on delete restrict,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  lease_token_hash text check (lease_token_hash is null or lease_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  result_row_count integer check (result_row_count is null or result_row_count >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (gateway_id, tenant_id)
    references public.connector_gateways(id, tenant_id) on delete cascade,
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete restrict,
  foreign key (query_id, tenant_id)
    references public.sql_analysis_queries(id, tenant_id) on delete cascade,
  check (
    (status = 'leased' and lease_token_hash is not null and lease_expires_at is not null)
    or (status <> 'leased' and lease_token_hash is null and lease_expires_at is null)
  ),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)),
  check ((status = 'failed') = (error_message is not null))
);

create unique index connector_gateway_jobs_one_active_query_idx
  on public.connector_gateway_jobs (tenant_id, query_id)
  where status in ('queued', 'leased');
create index connector_gateway_jobs_claim_idx
  on public.connector_gateway_jobs (gateway_id, queued_at, id)
  where status in ('queued', 'leased');
create index connector_gateway_jobs_tenant_query_idx
  on public.connector_gateway_jobs (tenant_id, query_id, queued_at desc);

alter table public.connector_gateways enable row level security;
alter table public.connector_gateway_jobs enable row level security;

create policy "connector gateways: selected tenant operator reads"
on public.connector_gateways for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);

create policy "connector gateway jobs: selected tenant operator reads"
on public.connector_gateway_jobs for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);

create function public.create_connector_gateway_enrollment(
  p_tenant_id uuid,
  p_name text,
  p_connector_name text,
  p_enrollment_token_hash text,
  p_enrollment_expires_at timestamptz,
  p_actor_user_id uuid
)
returns uuid language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_gateway_id uuid;
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or p_actor_user_id is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not (public.is_company_admin(p_tenant_id) or public.is_platform_admin()) then
    raise exception 'Only a selected-tenant Company Admin can create a gateway enrolment.';
  end if;
  if p_enrollment_token_hash !~ '^[0-9a-f]{64}$'
     or p_enrollment_expires_at <= clock_timestamp()
     or p_enrollment_expires_at > clock_timestamp() + interval '30 minutes' then
    raise exception 'Gateway enrolment token or expiry is invalid.';
  end if;
  insert into public.connector_gateways
    (tenant_id, name, connector_name, enrollment_token_hash,
     enrollment_expires_at, created_by)
  values
    (p_tenant_id, trim(p_name), trim(p_connector_name), p_enrollment_token_hash,
     p_enrollment_expires_at, p_actor_user_id)
  returning id into v_gateway_id;
  return v_gateway_id;
end;
$$;

create function public.begin_connector_gateway_enrollment(p_enrollment_token_hash text)
returns table (
  gateway_id uuid,
  tenant_id uuid,
  actor_user_id uuid,
  gateway_name text,
  connector_name text
)
language sql volatile security definer
set search_path = ''
as $$
  update public.connector_gateways gateway
     set status = 'enrolling', updated_at = clock_timestamp(), last_error = null
   where gateway.enrollment_token_hash = p_enrollment_token_hash
     and gateway.enrollment_expires_at > clock_timestamp()
     and (
       gateway.status = 'pending'
       or (gateway.status = 'enrolling' and gateway.updated_at < clock_timestamp() - interval '5 minutes')
     )
  returning gateway.id, gateway.tenant_id, gateway.created_by, gateway.name, gateway.connector_name
$$;

create function public.complete_connector_gateway_enrollment(
  p_gateway_id uuid,
  p_enrollment_token_hash text,
  p_device_token_hash text,
  p_connector_id uuid,
  p_installation_id uuid,
  p_machine_name text,
  p_platform text,
  p_worker_version text,
  p_protocol_version integer,
  p_capabilities jsonb
)
returns void language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_created_by uuid;
begin
  if p_device_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Gateway device token hash is invalid.';
  end if;
  select gateway.tenant_id, gateway.created_by into v_tenant_id, v_created_by
    from public.connector_gateways gateway
   where gateway.id = p_gateway_id
     and gateway.enrollment_token_hash = p_enrollment_token_hash
     and gateway.enrollment_expires_at > clock_timestamp()
     and gateway.status = 'enrolling'
   for update;
  if not found then raise exception 'Gateway enrolment is invalid, expired or already used.'; end if;
  if v_tenant_id is distinct from public.current_tenant_id()
     or v_created_by is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(v_tenant_id)
     or not (public.is_company_admin(v_tenant_id) or public.is_platform_admin()) then
    raise exception 'Gateway enrolment authority is no longer valid.';
  end if;
  if not exists (
    select 1 from public.connectors connector
     where connector.id = p_connector_id and connector.tenant_id = v_tenant_id
       and connector.connector_type in ('sql_server', 'azure_sql')
       and connector.config ->> 'networkMode' = 'gateway'
       and connector.config ->> 'gatewayId' = p_gateway_id::text
       and not exists (
         select 1 from public.connector_credentials credential
          where credential.connector_id = connector.id and credential.tenant_id = connector.tenant_id
       )
  ) then
    raise exception 'Gateway connector binding is invalid.';
  end if;
  update public.connector_gateways
     set status = 'active', device_token_hash = p_device_token_hash,
         connector_id = p_connector_id, installation_id = p_installation_id,
         machine_name = left(trim(p_machine_name), 160), platform = left(trim(p_platform), 120),
         worker_version = left(trim(p_worker_version), 40), protocol_version = p_protocol_version,
         capabilities = coalesce(p_capabilities, '{}'::jsonb), enrolled_at = clock_timestamp(),
         last_seen_at = clock_timestamp(), last_error = null, updated_at = clock_timestamp()
   where id = p_gateway_id;
end;
$$;

create function public.fail_connector_gateway_enrollment(
  p_gateway_id uuid,
  p_enrollment_token_hash text,
  p_error text
)
returns void language sql volatile security definer
set search_path = ''
as $$
  update public.connector_gateways
     set status = 'error', last_error = left(coalesce(p_error, 'Gateway enrolment failed.'), 500),
         updated_at = clock_timestamp()
   where id = p_gateway_id and enrollment_token_hash = p_enrollment_token_hash
     and status = 'enrolling'
$$;

create function public.revoke_connector_gateway(
  p_tenant_id uuid,
  p_gateway_id uuid,
  p_actor_user_id uuid
)
returns void language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_connector_id uuid;
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or p_actor_user_id is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not (public.is_company_admin(p_tenant_id) or public.is_platform_admin()) then
    raise exception 'Only a selected-tenant Company Admin can revoke a gateway.';
  end if;
  update public.connector_gateways
     set status = 'revoked', device_token_hash = null, last_error = null, updated_at = clock_timestamp()
   where id = p_gateway_id and tenant_id = p_tenant_id and status <> 'revoked'
  returning connector_id into v_connector_id;
  if not found then raise exception 'The gateway was not found or is already revoked.'; end if;
  update public.connector_gateway_jobs
     set status = 'cancelled', lease_token_hash = null, lease_expires_at = null,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and gateway_id = p_gateway_id
     and status in ('queued', 'leased');
  if v_connector_id is not null then
    update public.connectors set status = 'disabled', updated_at = clock_timestamp()
     where id = v_connector_id and tenant_id = p_tenant_id;
  end if;
end;
$$;

create function public.enqueue_connector_gateway_sql_analysis(
  p_tenant_id uuid,
  p_query_id uuid,
  p_actor_user_id uuid
)
returns uuid language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or p_actor_user_id is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not (public.is_kpi_governor(p_tenant_id) or public.is_platform_admin()) then
    raise exception 'Only a selected-tenant SQL analysis operator can queue a gateway job.';
  end if;
  select job.id into v_job_id
    from public.connector_gateway_jobs job
   where job.tenant_id = p_tenant_id and job.query_id = p_query_id
     and job.status in ('queued', 'leased')
   order by job.queued_at desc limit 1;
  if v_job_id is not null then return v_job_id; end if;
  insert into public.connector_gateway_jobs
    (tenant_id, gateway_id, connector_id, query_id, kind, actor_user_id)
  select query_row.tenant_id, gateway.id, connector.id, query_row.id,
         'sql_analysis', p_actor_user_id
    from public.sql_analysis_queries query_row
    join public.connectors connector
      on connector.id = query_row.connector_id and connector.tenant_id = query_row.tenant_id
    join public.connector_gateways gateway
      on gateway.id::text = connector.config ->> 'gatewayId'
     and gateway.tenant_id = connector.tenant_id
   where query_row.tenant_id = p_tenant_id and query_row.id = p_query_id
     and query_row.status <> 'retired'
     and connector.status = 'active'
     and connector.config ->> 'networkMode' = 'gateway'
     and gateway.status = 'active'
     and gateway.connector_id = connector.id
  returning id into v_job_id;
  if v_job_id is null then raise exception 'No active gateway is bound to this SQL analysis.'; end if;
  update public.sql_analysis_queries
     set last_run_status = 'queued', last_run_message = 'Waiting for the private SQL gateway',
         last_run_at = clock_timestamp(), updated_by = p_actor_user_id, updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = p_query_id;
  return v_job_id;
end;
$$;

create function public.claim_connector_gateway_job(
  p_device_token_hash text,
  p_lease_token_hash text
)
returns table (
  job_id uuid,
  sql_text text,
  max_rows integer,
  lease_expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_gateway_id uuid;
begin
  if p_device_token_hash !~ '^[0-9a-f]{64}$' or p_lease_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  update public.connector_gateways gateway
     set last_seen_at = clock_timestamp(), updated_at = clock_timestamp(), last_error = null
   where gateway.device_token_hash = p_device_token_hash and gateway.status = 'active'
  returning gateway.id into v_gateway_id;
  if v_gateway_id is null then return; end if;

  with exhausted as (
    update public.connector_gateway_jobs job
       set status = 'failed', lease_token_hash = null, lease_expires_at = null,
           completed_at = clock_timestamp(), error_message = 'Gateway job exceeded five lease attempts.',
           updated_at = clock_timestamp()
     where job.gateway_id = v_gateway_id and job.status = 'leased'
       and job.lease_expires_at <= clock_timestamp() and job.attempt_count >= 5
    returning job.tenant_id, job.query_id, job.actor_user_id
  )
  update public.sql_analysis_queries query_row
     set last_run_status = 'failed', last_run_message = 'Gateway job exceeded five lease attempts.',
         last_run_at = clock_timestamp(), updated_by = exhausted.actor_user_id,
         updated_at = clock_timestamp()
    from exhausted
   where query_row.tenant_id = exhausted.tenant_id and query_row.id = exhausted.query_id;

  return query
  with candidate as materialized (
    select job.id
      from public.connector_gateway_jobs job
      join public.connector_gateways gateway
        on gateway.id = job.gateway_id and gateway.tenant_id = job.tenant_id
       and gateway.status = 'active'
      join public.connectors connector
        on connector.id = job.connector_id and connector.tenant_id = job.tenant_id
       and connector.status = 'active' and connector.config ->> 'networkMode' = 'gateway'
       and connector.config ->> 'gatewayId' = gateway.id::text
      join public.sql_analysis_queries query_row
        on query_row.id = job.query_id and query_row.tenant_id = job.tenant_id
       and query_row.status <> 'retired' and query_row.connector_id = connector.id
      join public.tenants tenant on tenant.id = job.tenant_id and tenant.status = 'active'
      join public.tenant_product_entitlements entitlement
        on entitlement.tenant_id = job.tenant_id and entitlement.product_key = 'connect'
       and entitlement.status in ('active', 'trial')
      join public.tenant_memberships membership
        on membership.tenant_id = job.tenant_id and membership.user_id = job.actor_user_id
       and membership.status = 'active' and membership.role in ('company_admin', 'analyst')
     where job.gateway_id = v_gateway_id and job.attempt_count < 5
       and (job.status = 'queued' or (job.status = 'leased' and job.lease_expires_at <= clock_timestamp()))
     order by job.queued_at, job.id
     for update of job skip locked
     limit 1
  ), leased as (
    update public.connector_gateway_jobs job
       set status = 'leased', attempt_count = job.attempt_count + 1,
           lease_token_hash = p_lease_token_hash,
           lease_expires_at = clock_timestamp() + interval '90 seconds',
           claimed_at = coalesce(job.claimed_at, clock_timestamp()), updated_at = clock_timestamp()
      from candidate where job.id = candidate.id
    returning job.id, job.query_id, job.lease_expires_at
  )
  select leased.id, query_row.sql_text, 5000, leased.lease_expires_at
    from leased join public.sql_analysis_queries query_row on query_row.id = leased.query_id;
end;
$$;

create function public.authenticate_connector_gateway_device(p_device_token_hash text)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select p_device_token_hash ~ '^[0-9a-f]{64}$' and exists (
    select 1 from public.connector_gateways gateway
    join public.tenants tenant on tenant.id = gateway.tenant_id and tenant.status = 'active'
    join public.tenant_product_entitlements entitlement
      on entitlement.tenant_id = gateway.tenant_id and entitlement.product_key = 'connect'
     and entitlement.status in ('active', 'trial')
   where gateway.device_token_hash = p_device_token_hash and gateway.status = 'active'
  )
$$;

create function public.authenticate_connector_gateway_job_result(
  p_device_token_hash text,
  p_job_id uuid,
  p_lease_token_hash text
)
returns table (
  tenant_id uuid,
  actor_user_id uuid,
  query_id uuid,
  connector_id uuid,
  gateway_id uuid
)
language sql volatile security definer
set search_path = ''
as $$
  select job.tenant_id, job.actor_user_id, job.query_id, job.connector_id, job.gateway_id
    from public.connector_gateway_jobs job
    join public.connector_gateways gateway
      on gateway.id = job.gateway_id and gateway.tenant_id = job.tenant_id
   where job.id = p_job_id and job.status = 'leased'
     and job.lease_token_hash = p_lease_token_hash
     and job.lease_expires_at > clock_timestamp()
     and gateway.status = 'active' and gateway.device_token_hash = p_device_token_hash
$$;

create function public.finish_connector_gateway_job(
  p_tenant_id uuid,
  p_job_id uuid,
  p_device_token_hash text,
  p_lease_token_hash text,
  p_status text,
  p_result_row_count integer,
  p_error_message text,
  p_actor_user_id uuid
)
returns void language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or p_actor_user_id is distinct from public.current_user_id()
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not (public.is_kpi_governor(p_tenant_id) or public.is_platform_admin())
     or p_status not in ('succeeded', 'failed')
     or (p_status = 'succeeded' and (p_result_row_count is null or p_error_message is not null))
     or (p_status = 'failed' and (p_result_row_count is not null or p_error_message is null)) then
    raise exception 'Gateway job completion is invalid.';
  end if;
  update public.connector_gateway_jobs job
     set status = p_status, lease_token_hash = null, lease_expires_at = null,
         completed_at = clock_timestamp(), result_row_count = p_result_row_count,
         error_message = case when p_error_message is null then null else left(p_error_message, 500) end,
         updated_at = clock_timestamp()
    from public.connector_gateways gateway
   where job.id = p_job_id and job.tenant_id = p_tenant_id
     and job.actor_user_id = p_actor_user_id and job.status = 'leased'
     and job.lease_token_hash = p_lease_token_hash
     and job.lease_expires_at > clock_timestamp()
     and gateway.id = job.gateway_id and gateway.tenant_id = job.tenant_id
     and gateway.status = 'active' and gateway.device_token_hash = p_device_token_hash;
  if not found then raise exception 'Gateway job lease is invalid or expired.'; end if;
end;
$$;

revoke all on table public.connector_gateways from public;
revoke all on table public.connector_gateway_jobs from public;
revoke execute on function public.create_connector_gateway_enrollment(uuid,text,text,text,timestamptz,uuid) from public;
revoke execute on function public.begin_connector_gateway_enrollment(text) from public;
revoke execute on function public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb) from public;
revoke execute on function public.fail_connector_gateway_enrollment(uuid,text,text) from public;
revoke execute on function public.revoke_connector_gateway(uuid,uuid,uuid) from public;
revoke execute on function public.enqueue_connector_gateway_sql_analysis(uuid,uuid,uuid) from public;
revoke execute on function public.claim_connector_gateway_job(text,text) from public;
revoke execute on function public.authenticate_connector_gateway_device(text) from public;
revoke execute on function public.authenticate_connector_gateway_job_result(text,uuid,text) from public;
revoke execute on function public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'revoke all on public.connector_gateways from app_user';
    execute 'revoke all on public.connector_gateway_jobs from app_user';
    execute 'grant select (id, tenant_id, name, connector_name, status, enrollment_expires_at, enrolled_at, connector_id, installation_id, machine_name, platform, worker_version, protocol_version, capabilities, last_seen_at, last_error, created_by, created_at, updated_at) on public.connector_gateways to app_user';
    execute 'grant select (id, tenant_id, gateway_id, connector_id, query_id, kind, status, actor_user_id, attempt_count, lease_expires_at, queued_at, claimed_at, completed_at, result_row_count, error_message, created_at, updated_at) on public.connector_gateway_jobs to app_user';
    execute 'grant execute on function public.create_connector_gateway_enrollment(uuid,text,text,text,timestamptz,uuid) to app_user';
    execute 'grant execute on function public.begin_connector_gateway_enrollment(text) to app_user';
    execute 'grant execute on function public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb) to app_user';
    execute 'grant execute on function public.fail_connector_gateway_enrollment(uuid,text,text) to app_user';
    execute 'grant execute on function public.revoke_connector_gateway(uuid,uuid,uuid) to app_user';
    execute 'grant execute on function public.enqueue_connector_gateway_sql_analysis(uuid,uuid,uuid) to app_user';
    execute 'grant execute on function public.claim_connector_gateway_job(text,text) to app_user';
    execute 'grant execute on function public.authenticate_connector_gateway_device(text) to app_user';
    execute 'grant execute on function public.authenticate_connector_gateway_job_result(text,uuid,text) to app_user';
    execute 'grant execute on function public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid) to app_user';
  end if;
end
$$;
