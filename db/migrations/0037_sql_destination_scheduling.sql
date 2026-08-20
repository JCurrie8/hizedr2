-- Automatically advance accepted source revisions into the SQL workbench.
-- Scheduling state lives on the destination binding because source polling
-- and workbench delivery are separate stages with separate failure/retry
-- semantics and credentials.

alter table public.pipeline_sql_destinations
  add column schedule_enabled boolean not null default false,
  add column schedule_interval_minutes integer not null default 60
    check (schedule_interval_minutes in (60, 180, 360, 720, 1440)),
  add column next_load_at timestamptz,
  add column last_attempt_at timestamptz,
  add column last_success_at timestamptz,
  add column last_error text,
  add column consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  add column next_retry_at timestamptz,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add constraint pipeline_sql_destinations_schedule_state_check check (
    (schedule_enabled and next_load_at is not null)
    or (not schedule_enabled and next_load_at is null)
  ),
  add constraint pipeline_sql_destinations_lease_state_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  );

create index pipeline_sql_destinations_due_idx
  on public.pipeline_sql_destinations (next_load_at, id)
  where schedule_enabled and status = 'active';

-- This is the only cross-tenant SQL-destination scheduler entry point. It
-- returns identifiers plus one active Connect operator. The actual load then
-- re-enters ordinary selected-tenant RLS before credentials or records are
-- read. Only the latest successful/warning source revision is eligible, and a
-- revision that already reached SQL successfully is never claimed again.
create function public.claim_due_sql_destination_syncs(p_limit integer default 5)
returns table (
  tenant_id uuid,
  connector_id uuid,
  pipeline_id uuid,
  destination_id uuid,
  actor_user_id uuid,
  lease_token uuid
)
language sql volatile security definer
set search_path = ''
as $$
  with candidates as materialized (
    select
      d.id as destination_id,
      d.tenant_id,
      d.pipeline_id,
      d.connector_id,
      operator.user_id as actor_user_id
    from public.pipeline_sql_destinations d
    join public.pipelines p
      on p.id = d.pipeline_id and p.tenant_id = d.tenant_id
    join public.connectors source
      on source.id = p.connector_id and source.tenant_id = p.tenant_id
    join public.connectors destination
      on destination.id = d.connector_id and destination.tenant_id = d.tenant_id
    join public.connector_credentials credential
      on credential.connector_id = destination.id
     and credential.tenant_id = destination.tenant_id
    join public.tenants tenant
      on tenant.id = d.tenant_id and tenant.status = 'active'
    join public.tenant_product_entitlements entitlement
      on entitlement.tenant_id = d.tenant_id
     and entitlement.product_key = 'connect'
     and entitlement.status in ('active', 'trial')
    join lateral (
      select run.id, run.finished_at
      from public.pipeline_runs run
      where run.pipeline_id = d.pipeline_id
        and run.tenant_id = d.tenant_id
        and run.status in ('succeeded', 'warning')
      order by run.finished_at desc, run.id
      limit 1
    ) latest_source on true
    left join public.pipeline_sql_destination_runs destination_run
      on destination_run.destination_id = d.id
     and destination_run.source_run_id = latest_source.id
     and destination_run.tenant_id = d.tenant_id
    join lateral (
      select membership.user_id
      from public.tenant_memberships membership
      where membership.tenant_id = d.tenant_id
        and membership.status = 'active'
        and membership.role in ('company_admin', 'analyst')
      order by (membership.user_id = d.created_by) desc,
               membership.created_at, membership.user_id
      limit 1
    ) operator on true
    where d.status = 'active'
      and d.schedule_enabled
      and d.next_load_at <= clock_timestamp()
      and (d.next_retry_at is null or d.next_retry_at <= clock_timestamp())
      and (d.lease_expires_at is null or d.lease_expires_at <= clock_timestamp())
      and p.status = 'active'
      and source.status in ('active', 'error')
      and destination.status = 'active'
      and destination.connector_type in ('sql_server', 'azure_sql')
      and destination.config ->> 'direction' = 'destination'
      and (
        destination_run.id is null
        or destination_run.status = 'failed'
        or (
          destination_run.status = 'running'
          and destination_run.started_at <= clock_timestamp() - interval '15 minutes'
        )
      )
    order by d.next_load_at, d.id
    for update of d skip locked
    limit least(greatest(coalesce(p_limit, 5), 1), 20)
  ), leased as (
    update public.pipeline_sql_destinations destination
    set lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '15 minutes',
        last_attempt_at = clock_timestamp(),
        updated_at = clock_timestamp()
    from candidates candidate
    where destination.id = candidate.destination_id
      and destination.tenant_id = candidate.tenant_id
    returning destination.id, destination.tenant_id,
              destination.pipeline_id, destination.connector_id,
              destination.lease_token
  )
  select leased.tenant_id, leased.connector_id, leased.pipeline_id,
         leased.id, candidate.actor_user_id, leased.lease_token
  from leased
  join candidates candidate
    on candidate.destination_id = leased.id
   and candidate.tenant_id = leased.tenant_id
$$;

revoke execute on function public.claim_due_sql_destination_syncs(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.claim_due_sql_destination_syncs(integer) to app_user';
  end if;
end
$$;
