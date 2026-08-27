-- EPIC-06/07/12: saved, bounded SQL analysis for Canvas and Pulse. Query
-- results use a deliberately narrow semantic row contract so arbitrary source
-- fields never bypass organisation scope. Company Admin certification promotes
-- a result series into the existing governed KPI catalogue and value store.

create table public.sql_analysis_queries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_id uuid not null,
  name text not null check (length(trim(name)) between 2 and 120),
  description text not null default '' check (length(description) <= 1000),
  sql_text text not null check (length(trim(sql_text)) between 8 and 50000),
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'draft' check (status in ('draft', 'validated', 'certified', 'retired')),
  result_signature jsonb not null default '[]'::jsonb check (jsonb_typeof(result_signature) = 'array'),
  last_run_status text check (last_run_status is null or last_run_status in ('succeeded', 'failed')),
  last_run_message text,
  last_row_count integer check (last_row_count is null or last_row_count >= 0),
  last_run_at timestamptz,
  source_refreshed_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete restrict
);

create index sql_analysis_queries_tenant_status_idx
  on public.sql_analysis_queries (tenant_id, status, updated_at desc);
create index sql_analysis_queries_connector_idx
  on public.sql_analysis_queries (tenant_id, connector_id);

create table public.sql_analysis_rows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  query_id uuid not null,
  row_index integer not null check (row_index >= 0),
  org_node_id uuid not null,
  series_key text not null check (series_key ~ '^[a-z][a-z0-9_]*$'),
  series_label text not null check (length(trim(series_label)) between 1 and 120),
  category_label text not null check (length(category_label) <= 160),
  period_start date not null,
  period_end date not null,
  actual_value numeric not null,
  target_value numeric,
  prior_period_value numeric,
  numerator_value numeric,
  denominator_value numeric,
  source_refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, query_id, row_index),
  foreign key (query_id, tenant_id)
    references public.sql_analysis_queries(id, tenant_id) on delete cascade,
  foreign key (org_node_id, tenant_id)
    references public.org_nodes(id, tenant_id) on delete restrict,
  check (period_end > period_start),
  check (
    (numerator_value is null and denominator_value is null)
    or (numerator_value is not null and denominator_value is not null and denominator_value <> 0)
  )
);

create index sql_analysis_rows_query_period_idx
  on public.sql_analysis_rows (tenant_id, query_id, period_end desc);
create index sql_analysis_rows_scope_idx
  on public.sql_analysis_rows (tenant_id, org_node_id, query_id);

create table public.analytics_widget_query_sources (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  widget_id uuid primary key,
  query_id uuid not null,
  unit text not null default 'number' check (unit in ('number', 'percentage', 'currency', 'duration', 'score')),
  currency_code text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  decimal_places smallint not null default 0 check (decimal_places between 0 and 6),
  favourable_direction text not null default 'higher' check (favourable_direction in ('higher', 'lower', 'target')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (widget_id, tenant_id)
    references public.analytics_widgets(id, tenant_id) on delete cascade,
  foreign key (query_id, tenant_id)
    references public.sql_analysis_queries(id, tenant_id) on delete restrict,
  check ((unit = 'currency') = (currency_code is not null))
);

create index analytics_widget_query_sources_query_idx
  on public.analytics_widget_query_sources (tenant_id, query_id, widget_id);

create table public.sql_analysis_certifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  query_id uuid not null,
  series_key text not null check (series_key ~ '^[a-z][a-z0-9_]*$'),
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  dataset_id uuid not null,
  kpi_definition_id uuid not null,
  row_count integer not null check (row_count > 0),
  certified_by uuid not null references public.profiles(id) on delete restrict,
  certified_at timestamptz not null default now(),
  unique (tenant_id, query_id, series_key, query_hash),
  foreign key (query_id, tenant_id)
    references public.sql_analysis_queries(id, tenant_id) on delete restrict,
  foreign key (dataset_id, tenant_id)
    references public.governed_datasets(id, tenant_id) on delete restrict,
  foreign key (kpi_definition_id, tenant_id)
    references public.kpi_definitions(id, tenant_id) on delete restrict
);

create index sql_analysis_certifications_query_idx
  on public.sql_analysis_certifications (tenant_id, query_id, certified_at desc);
create index sql_analysis_certifications_kpi_idx
  on public.sql_analysis_certifications (tenant_id, kpi_definition_id);

create or replace function public.can_read_sql_analysis_row(
  p_tenant_id uuid,
  p_query_id uuid,
  p_org_node_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and (
      public.is_kpi_governor(p_tenant_id)
      or public.is_platform_admin()
      or exists (
        select 1
          from public.analytics_widget_query_sources source
          join public.analytics_widgets widget
            on widget.id = source.widget_id and widget.tenant_id = source.tenant_id
         where source.tenant_id = p_tenant_id
           and source.query_id = p_query_id
           and public.can_read_analytics_view_child(widget.tenant_id, widget.view_id)
      )
    )
    and (
      public.is_company_admin(p_tenant_id)
      or public.is_platform_admin()
      or exists (
        select 1
          from public.org_node_versions version
         where version.tenant_id = p_tenant_id
           and version.org_node_id = p_org_node_id
           and version.valid_from <= current_date
           and (version.valid_to is null or version.valid_to > current_date)
           and exists (
             select 1
               from unnest(public.current_user_scope_paths()) as scope(path)
              where version.path OPERATOR(public.<@) scope.path
           )
      )
    )
$$;

alter table public.sql_analysis_queries enable row level security;
alter table public.sql_analysis_rows enable row level security;
alter table public.analytics_widget_query_sources enable row level security;
alter table public.sql_analysis_certifications enable row level security;

create policy "SQL analyses: selected tenant governors"
on public.sql_analysis_queries for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
);

create policy "SQL analysis rows: scoped visual reads"
on public.sql_analysis_rows for select
using (public.can_read_sql_analysis_row(tenant_id, query_id, org_node_id));

create policy "SQL analysis rows: selected tenant governor writes"
on public.sql_analysis_rows for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "analytics widget query sources: permitted reads"
on public.analytics_widget_query_sources for select
using (
  tenant_id = public.current_tenant_id()
  and exists (
    select 1 from public.analytics_widgets widget
     where widget.tenant_id = analytics_widget_query_sources.tenant_id
       and widget.id = analytics_widget_query_sources.widget_id
       and public.can_read_analytics_view_child(widget.tenant_id, widget.view_id)
  )
);

create policy "analytics widget query sources: selected tenant writes"
on public.analytics_widget_query_sources for all
using (
  tenant_id = public.current_tenant_id()
  and exists (
    select 1 from public.analytics_widgets widget
     where widget.tenant_id = analytics_widget_query_sources.tenant_id
       and widget.id = analytics_widget_query_sources.widget_id
       and public.can_edit_analytics_view(widget.tenant_id, widget.view_id)
  )
)
with check (
  tenant_id = public.current_tenant_id()
  and created_by = public.current_user_id()
  and exists (
    select 1 from public.analytics_widgets widget
     where widget.tenant_id = analytics_widget_query_sources.tenant_id
       and widget.id = analytics_widget_query_sources.widget_id
       and public.can_edit_analytics_view(widget.tenant_id, widget.view_id)
  )
  and exists (
    select 1 from public.sql_analysis_queries query_row
     where query_row.tenant_id = analytics_widget_query_sources.tenant_id
       and query_row.id = analytics_widget_query_sources.query_id
       and query_row.status in ('validated', 'certified')
  )
);

create policy "SQL analysis certifications: permitted reads"
on public.sql_analysis_certifications for select
using (
  tenant_id = public.current_tenant_id()
  and (
    public.is_kpi_governor(tenant_id)
    or public.is_platform_admin()
    or public.can_read_kpi_definition(tenant_id, kpi_definition_id)
  )
);

create policy "SQL analysis certifications: selected tenant admin inserts"
on public.sql_analysis_certifications for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_company_admin(tenant_id) or public.is_platform_admin())
  and certified_by = public.current_user_id()
);

revoke all on table public.sql_analysis_queries from public;
revoke all on table public.sql_analysis_rows from public;
revoke all on table public.analytics_widget_query_sources from public;
revoke all on table public.sql_analysis_certifications from public;
revoke execute on function public.can_read_sql_analysis_row(uuid, uuid, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant select, insert, update, delete on public.sql_analysis_queries to app_user';
    execute 'grant select, insert, update, delete on public.sql_analysis_rows to app_user';
    execute 'grant select, insert, update, delete on public.analytics_widget_query_sources to app_user';
    execute 'grant select, insert on public.sql_analysis_certifications to app_user';
    execute 'grant execute on function public.can_read_sql_analysis_row(uuid, uuid, uuid) to app_user';
  end if;
end
$$;
