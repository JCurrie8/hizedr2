-- Suspending a tenant must also stop background Connect work. The interactive
-- application already fails closed through the tenant authority helpers, but
-- this scheduler function is deliberately cross-tenant and SECURITY DEFINER.

create or replace function public.claim_due_sharepoint_syncs(p_limit integer default 5)
returns table (
  tenant_id uuid,
  connector_id uuid,
  pipeline_id uuid,
  actor_user_id uuid,
  lease_token uuid
)
language sql volatile security definer
set search_path = ''
as $$
  with candidates as materialized (
    select
      css.connector_id,
      css.tenant_id,
      p.id as pipeline_id,
      operator.user_id as actor_user_id
    from public.connector_sync_state css
    join public.connectors c
      on c.id = css.connector_id and c.tenant_id = css.tenant_id
    join public.tenants tenant
      on tenant.id = c.tenant_id
     and tenant.status = 'active'
    join public.tenant_product_entitlements entitlement
      on entitlement.tenant_id = c.tenant_id
     and entitlement.product_key = 'connect'
     and entitlement.status in ('active', 'trial')
    join lateral (
      select candidate_pipeline.id
      from public.pipelines candidate_pipeline
      where candidate_pipeline.connector_id = c.id
        and candidate_pipeline.tenant_id = c.tenant_id
        and candidate_pipeline.status = 'active'
      order by candidate_pipeline.created_at, candidate_pipeline.id
      limit 1
    ) p on true
    join public.connector_credentials cc
      on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
    join lateral (
      select m.user_id
      from public.tenant_memberships m
      where m.tenant_id = c.tenant_id
        and m.status = 'active'
        and m.role in ('company_admin', 'analyst')
      order by (m.user_id = c.created_by) desc, m.created_at, m.user_id
      limit 1
    ) operator on true
    where c.connector_type = 'sharepoint'
      and c.status in ('active', 'error')
      and css.next_poll_at <= clock_timestamp()
      and (css.next_retry_at is null or css.next_retry_at <= clock_timestamp())
      and (css.lease_expires_at is null or css.lease_expires_at <= clock_timestamp())
    order by css.next_poll_at, css.connector_id
    for update of css skip locked
    limit least(greatest(coalesce(p_limit, 5), 1), 20)
  ), leased as (
    update public.connector_sync_state css
    set lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '10 minutes',
        updated_at = clock_timestamp()
    from candidates candidate
    where css.connector_id = candidate.connector_id
      and css.tenant_id = candidate.tenant_id
    returning css.tenant_id, css.connector_id, css.lease_token
  )
  select leased.tenant_id, leased.connector_id, candidate.pipeline_id,
         candidate.actor_user_id, leased.lease_token
  from leased
  join candidates candidate
    on candidate.connector_id = leased.connector_id
   and candidate.tenant_id = leased.tenant_id
$$;

revoke execute on function public.claim_due_sharepoint_syncs(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.claim_due_sharepoint_syncs(integer) to app_user';
  end if;
end
$$;
