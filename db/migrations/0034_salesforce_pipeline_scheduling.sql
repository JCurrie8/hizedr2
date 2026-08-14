-- Salesforce connections can own several object pipelines, so scheduling and
-- leases must be pipeline-scoped rather than reusing SharePoint's deliberately
-- one-workbook-per-connector state row.

create table public.pipeline_sync_state (
  pipeline_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  poll_interval_minutes integer not null default 1440
    check (poll_interval_minutes between 60 and 1440),
  next_poll_at timestamptz not null default now(),
  last_polled_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_retry_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (pipeline_id, tenant_id),
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade,
  check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  )
);

create index pipeline_sync_state_due_idx
  on public.pipeline_sync_state (next_poll_at, pipeline_id)
  where lease_token is null;

alter table public.pipeline_sync_state enable row level security;

-- Keep one complete selected-tenant predicate. A broader permissive read
-- policy would OR with this one and recreate the leak shape fixed in 0006/0011.
create policy "pipeline sync state: scoped operator access"
on public.pipeline_sync_state for all
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

-- This is the only cross-tenant Salesforce scheduler entry point. It returns
-- identifiers plus one active Connect operator; the claimed run immediately
-- re-enters ordinary user/tenant RLS before reading credentials or data.
create or replace function public.claim_due_salesforce_syncs(p_limit integer default 5)
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
      pss.pipeline_id,
      pss.tenant_id,
      p.connector_id,
      operator.user_id as actor_user_id
    from public.pipeline_sync_state pss
    join public.pipelines p
      on p.id = pss.pipeline_id and p.tenant_id = pss.tenant_id
    join public.connectors c
      on c.id = p.connector_id and c.tenant_id = p.tenant_id
    join public.tenants tenant
      on tenant.id = p.tenant_id and tenant.status = 'active'
    join public.tenant_product_entitlements entitlement
      on entitlement.tenant_id = p.tenant_id
     and entitlement.product_key = 'connect'
     and entitlement.status in ('active', 'trial')
    join public.connector_credentials cc
      on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
    join lateral (
      select membership.user_id
      from public.tenant_memberships membership
      where membership.tenant_id = p.tenant_id
        and membership.status = 'active'
        and membership.role in ('company_admin', 'analyst')
      order by (membership.user_id = p.created_by) desc,
               membership.created_at, membership.user_id
      limit 1
    ) operator on true
    where c.connector_type = 'salesforce'
      and c.status in ('active', 'error')
      and p.status = 'active'
      and pss.next_poll_at <= clock_timestamp()
      and (pss.next_retry_at is null or pss.next_retry_at <= clock_timestamp())
      and (pss.lease_expires_at is null or pss.lease_expires_at <= clock_timestamp())
    order by pss.next_poll_at, pss.pipeline_id
    for update of pss skip locked
    limit least(greatest(coalesce(p_limit, 5), 1), 20)
  ), leased as (
    update public.pipeline_sync_state pss
    set lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '10 minutes',
        updated_at = clock_timestamp()
    from candidates candidate
    where pss.pipeline_id = candidate.pipeline_id
      and pss.tenant_id = candidate.tenant_id
    returning pss.pipeline_id, pss.tenant_id, pss.lease_token
  )
  select leased.tenant_id, candidate.connector_id, leased.pipeline_id,
         candidate.actor_user_id, leased.lease_token
  from leased
  join candidates candidate
    on candidate.pipeline_id = leased.pipeline_id
   and candidate.tenant_id = leased.tenant_id
$$;

revoke execute on function public.claim_due_salesforce_syncs(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.claim_due_salesforce_syncs(integer) to app_user';
  end if;
end
$$;
