-- Let the polling API distinguish an authenticated idle gateway from a
-- revoked, suspended or unknown device without exposing gateway rows.

create or replace function public.authenticate_connector_gateway_device(p_device_token_hash text)
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

revoke execute on function public.authenticate_connector_gateway_device(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.authenticate_connector_gateway_device(text) to app_user';
  end if;
end
$$;
