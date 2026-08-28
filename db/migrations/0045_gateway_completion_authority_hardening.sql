-- Bind gateway completion to a still-active selected-tenant SQL-analysis
-- operator as well as the device and lease tokens. This preserves fail-closed
-- behaviour when the initiating user is suspended while a job is in flight.

create or replace function public.finish_connector_gateway_job(
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

revoke execute on function public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid) to app_user';
  end if;
end
$$;
