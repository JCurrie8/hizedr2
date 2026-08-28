-- Defence in depth for databases whose owner role has broad default table
-- privileges for app_user. Gateway state is readable through RLS, but every
-- mutation must pass through the authority-bound SECURITY DEFINER functions.

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
