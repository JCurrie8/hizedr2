-- Commercial product access is tenant-scoped and owned by Hized Platform
-- Administration. Company Admins can configure how enabled products are used,
-- but cannot enable a product their company has not purchased.

create table public.tenant_product_entitlements (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_key text not null check (product_key in ('pulse', 'connect', 'canvas')),
  status text not null check (status in ('active', 'trial', 'locked')),
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now(),
  primary key (tenant_id, product_key)
);

alter table public.tenant_product_entitlements enable row level security;

-- Keep the selected-tenant predicate attached to every policy branch. A role
-- check on its own would recreate the multi-tenant admin leak shape repaired in
-- migrations 0006 and 0011.
create policy "product entitlements: selected tenant reads"
on public.tenant_product_entitlements for select
using (
  tenant_id = public.current_tenant_id()
  and (
    public.current_user_has_tenant_access(tenant_id)
    or public.is_platform_admin()
  )
);

create policy "product entitlements: selected tenant platform admin inserts"
on public.tenant_product_entitlements for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.is_platform_admin()
);

create policy "product entitlements: selected tenant platform admin updates"
on public.tenant_product_entitlements for update
using (
  tenant_id = public.current_tenant_id()
  and public.is_platform_admin()
)
with check (
  tenant_id = public.current_tenant_id()
  and public.is_platform_admin()
);

-- Preserve access to the already-released products. Canvas is visible in the
-- product hub but locked until a tenant is explicitly entitled to it.
insert into public.tenant_product_entitlements (tenant_id, product_key, status)
select tenants.id, defaults.product_key, defaults.entitlement_status
from public.tenants tenants
cross join (values
  ('pulse', 'active'),
  ('connect', 'active'),
  ('canvas', 'locked')
) as defaults(product_key, entitlement_status)
on conflict (tenant_id, product_key) do nothing;

-- New tenants receive the same explicit baseline without relying on application
-- code or on a tenant context that cannot exist until membership is provisioned.
create or replace function public.seed_tenant_product_entitlements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_product_entitlements (tenant_id, product_key, status)
  values
    (new.id, 'pulse', 'active'),
    (new.id, 'connect', 'active'),
    (new.id, 'canvas', 'locked');
  return new;
end;
$$;

create trigger seed_tenant_product_entitlements_after_tenant_insert
after insert on public.tenants
for each row execute function public.seed_tenant_product_entitlements();

revoke execute on function public.seed_tenant_product_entitlements() from public;

-- Scheduled Connect work must stop when the commercial entitlement is locked;
-- guarding only the interactive page would leave background ingestion running.
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
