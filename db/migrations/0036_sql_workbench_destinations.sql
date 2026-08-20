-- Hized Connect's SQL workbench stage. Source pipelines may publish their
-- accepted current state to one separately-authenticated SQL destination.
-- The destination connector itself remains tenant-scoped by the existing
-- connector RLS; these tables bind the stage configuration and load ledger.

create table public.pipeline_sql_destinations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  connector_id uuid not null,
  target_schema text not null check (target_schema ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  target_table text not null check (target_table ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  load_mode text not null default 'snapshot' check (load_mode = 'snapshot'),
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (pipeline_id),
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade,
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete restrict
);

create unique index pipeline_sql_destinations_target_idx
  on public.pipeline_sql_destinations
    (connector_id, lower(target_schema), lower(target_table));
create index pipeline_sql_destinations_tenant_status_idx
  on public.pipeline_sql_destinations (tenant_id, status);

create table public.pipeline_sql_destination_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  destination_id uuid not null,
  source_run_id uuid not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attempt integer not null default 1 check (attempt > 0),
  rows_written integer not null default 0 check (rows_written >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  message text,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (destination_id, source_run_id),
  foreign key (destination_id, tenant_id)
    references public.pipeline_sql_destinations(id, tenant_id) on delete cascade,
  foreign key (source_run_id, tenant_id)
    references public.pipeline_runs(id, tenant_id) on delete restrict,
  check (finished_at is null or finished_at >= started_at),
  check ((status = 'running' and finished_at is null) or (status <> 'running' and finished_at is not null))
);

create index pipeline_sql_destination_runs_tenant_started_idx
  on public.pipeline_sql_destination_runs (tenant_id, started_at desc);

create function public.validate_pipeline_sql_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_connector uuid;
  v_destination_type text;
  v_destination_direction text;
begin
  select p.connector_id
    into v_source_connector
    from public.pipelines p
   where p.id = new.pipeline_id and p.tenant_id = new.tenant_id;

  select c.connector_type, c.config ->> 'direction'
    into v_destination_type, v_destination_direction
    from public.connectors c
   where c.id = new.connector_id and c.tenant_id = new.tenant_id;

  if v_source_connector is null or v_destination_type is null then
    raise exception 'The source pipeline or SQL destination is unavailable.';
  end if;
  if v_source_connector = new.connector_id then
    raise exception 'A source connector cannot also be its SQL destination.';
  end if;
  if v_destination_type not in ('sql_server', 'azure_sql')
     or v_destination_direction is distinct from 'destination' then
    raise exception 'The selected connector is not a SQL workbench destination.';
  end if;
  return new;
end;
$$;

revoke execute on function public.validate_pipeline_sql_destination() from public;

create trigger pipeline_sql_destinations_validate
before insert or update of tenant_id, pipeline_id, connector_id
on public.pipeline_sql_destinations
for each row execute function public.validate_pipeline_sql_destination();

create function public.validate_pipeline_sql_destination_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.pipeline_sql_destinations d
      join public.pipeline_runs r
        on r.id = new.source_run_id
       and r.tenant_id = new.tenant_id
       and r.pipeline_id = d.pipeline_id
     where d.id = new.destination_id
       and d.tenant_id = new.tenant_id
  ) then
    raise exception 'The source run does not belong to the destination pipeline.';
  end if;
  return new;
end;
$$;

revoke execute on function public.validate_pipeline_sql_destination_run() from public;

create trigger pipeline_sql_destination_runs_validate
before insert or update of tenant_id, destination_id, source_run_id
on public.pipeline_sql_destination_runs
for each row execute function public.validate_pipeline_sql_destination_run();

alter table public.pipeline_sql_destinations enable row level security;
alter table public.pipeline_sql_destination_runs enable row level security;

create policy "pipeline SQL destinations: scoped operator access"
on public.pipeline_sql_destinations for all
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

create policy "pipeline SQL destination runs: scoped operator access"
on public.pipeline_sql_destination_runs for all
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

revoke all on table public.pipeline_sql_destinations from public;
revoke all on table public.pipeline_sql_destination_runs from public;
grant select, insert, update, delete on table public.pipeline_sql_destinations to app_user;
grant select, insert, update, delete on table public.pipeline_sql_destination_runs to app_user;

grant execute on function public.validate_pipeline_sql_destination() to app_user;
grant execute on function public.validate_pipeline_sql_destination_run() to app_user;
