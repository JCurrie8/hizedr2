-- Token hashes authenticate the unauthenticated gateway protocol and are not
-- operator-facing state. Keep them unreadable to app_user even when RLS allows
-- an operator to inspect the containing gateway or job row.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'revoke all on public.connector_gateways from app_user';
    execute 'revoke all on public.connector_gateway_jobs from app_user';
    execute 'grant select (id, tenant_id, name, connector_name, status, enrollment_expires_at, enrolled_at, connector_id, installation_id, machine_name, platform, worker_version, protocol_version, capabilities, last_seen_at, last_error, created_by, created_at, updated_at) on public.connector_gateways to app_user';
    execute 'grant select (id, tenant_id, gateway_id, connector_id, query_id, kind, status, actor_user_id, attempt_count, lease_expires_at, queued_at, claimed_at, completed_at, result_row_count, error_message, created_at, updated_at) on public.connector_gateway_jobs to app_user';
  end if;
end
$$;

-- Enrolment completion already requires the one-time token and connector
-- binding. Also require the original operator's still-active selected-tenant
-- authority before activating the device.
create or replace function public.complete_connector_gateway_enrollment(
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

revoke execute on function public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb) to app_user';
  end if;
end
$$;
