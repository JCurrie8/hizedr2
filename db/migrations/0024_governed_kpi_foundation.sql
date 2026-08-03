-- EPIC-06/07: governed dataset metadata and the first reusable KPI value
-- contract. Business definitions live here rather than inside Pulse widgets.
-- Approved KPI rows are immutable: a changed definition is a new version.

alter table public.org_nodes
  add constraint org_nodes_id_tenant_unique unique (id, tenant_id);

create table public.governed_datasets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dataset_key text not null check (dataset_key ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '',
  subject_area text not null check (length(trim(subject_area)) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  source_pipeline_id uuid,
  refresh_cadence text not null,
  expected_latency interval not null check (expected_latency > interval '0 seconds'),
  last_refreshed_at timestamptz,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dataset_key),
  unique (id, tenant_id),
  foreign key (source_pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete restrict
);

create table public.governed_dataset_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dataset_id uuid not null,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '',
  data_type text not null check (data_type in ('text', 'integer', 'decimal', 'boolean', 'date', 'timestamp')),
  field_role text not null check (field_role in ('identifier', 'dimension', 'measure', 'time')),
  aggregation text check (aggregation is null or aggregation in ('sum', 'average', 'distinct_count', 'ratio', 'snapshot', 'semi_additive')),
  is_sensitive boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, dataset_id, field_key),
  foreign key (dataset_id, tenant_id)
    references public.governed_datasets(id, tenant_id) on delete cascade
);

create table public.kpi_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dataset_id uuid not null,
  kpi_key text not null check (kpi_key ~ '^[a-z][a-z0-9_]*$'),
  version_number integer not null check (version_number > 0),
  name text not null check (length(trim(name)) between 1 and 120),
  definition text not null check (length(trim(definition)) > 0),
  business_purpose text not null default '',
  formula_reference text not null check (length(trim(formula_reference)) > 0),
  owner_name text not null check (length(trim(owner_name)) > 0),
  unit text not null check (unit in ('number', 'percentage', 'currency', 'duration', 'score')),
  currency_code text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  decimal_places smallint not null default 0 check (decimal_places between 0 and 6),
  favourable_direction text not null check (favourable_direction in ('higher', 'lower', 'target')),
  aggregation text not null check (aggregation in ('sum', 'average', 'distinct_count', 'ratio', 'snapshot', 'semi_additive')),
  refresh_cadence text not null,
  thresholds jsonb not null default '{}'::jsonb check (jsonb_typeof(thresholds) = 'object'),
  permitted_dimensions text[] not null default '{}',
  audience_roles public.app_role[] not null default enum_range(null::public.app_role),
  valid_from date not null,
  valid_to date,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'approved', 'rejected')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, kpi_key, version_number),
  unique (id, tenant_id),
  foreign key (dataset_id, tenant_id)
    references public.governed_datasets(id, tenant_id) on delete restrict,
  check ((unit = 'currency') = (currency_code is not null)),
  check (valid_to is null or valid_to > valid_from),
  check (
    (approval_status = 'approved' and approved_by is not null and approved_at is not null)
    or (approval_status <> 'approved' and approved_by is null and approved_at is null)
  )
);

create unique index kpi_definitions_one_current_approved_idx
  on public.kpi_definitions (tenant_id, kpi_key)
  where approval_status = 'approved' and valid_to is null;

create table public.kpi_values (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kpi_definition_id uuid not null,
  org_node_id uuid not null,
  period_start date not null,
  period_end date not null,
  actual_value numeric not null,
  target_value numeric,
  prior_period_value numeric,
  numerator_value numeric,
  denominator_value numeric,
  source_refreshed_at timestamptz not null,
  calculated_at timestamptz not null default now(),
  calculated_by uuid not null references public.profiles(id),
  unique (tenant_id, kpi_definition_id, org_node_id, period_start, period_end),
  foreign key (kpi_definition_id, tenant_id)
    references public.kpi_definitions(id, tenant_id) on delete restrict,
  foreign key (org_node_id, tenant_id)
    references public.org_nodes(id, tenant_id) on delete restrict,
  check (period_end > period_start),
  check (
    (numerator_value is null and denominator_value is null)
    or (numerator_value is not null and denominator_value is not null and denominator_value <> 0)
  )
);

create index governed_datasets_tenant_status_idx
  on public.governed_datasets (tenant_id, status);
create index kpi_definitions_tenant_status_idx
  on public.kpi_definitions (tenant_id, approval_status, valid_from, valid_to);
create index kpi_values_tenant_period_idx
  on public.kpi_values (tenant_id, period_end desc, kpi_definition_id);
create index kpi_values_org_period_idx
  on public.kpi_values (tenant_id, org_node_id, period_end desc);

-- These helpers deliberately run as the migration owner so policy decisions do
-- not depend on nested RLS reads. They bind every decision to both session
-- variables and expose no data themselves.
create or replace function public.is_kpi_governor(p_tenant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = public.current_user_id()
      and membership.status = 'active'
      and membership.role in ('company_admin', 'analyst')
  )
$$;

create or replace function public.can_read_governed_dataset(p_tenant_id uuid, p_dataset_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
      from public.governed_datasets dataset
      where dataset.id = p_dataset_id
        and dataset.tenant_id = p_tenant_id
        and (dataset.status = 'published' or public.is_kpi_governor(p_tenant_id) or public.is_platform_admin())
    )
$$;

create or replace function public.can_read_kpi_definition(p_tenant_id uuid, p_kpi_definition_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
      from public.kpi_definitions definition
      join public.tenant_memberships membership
        on membership.tenant_id = definition.tenant_id
       and membership.user_id = public.current_user_id()
       and membership.status = 'active'
      where definition.id = p_kpi_definition_id
        and definition.tenant_id = p_tenant_id
        and (
          (definition.approval_status = 'approved' and membership.role = any(definition.audience_roles))
          or public.is_kpi_governor(p_tenant_id)
          or public.is_platform_admin()
        )
    )
$$;

-- The definition table's own SELECT policy cannot safely call the id-based
-- helper above for INSERT ... RETURNING: the statement snapshot may not expose
-- the new row to a self-query yet. Pass the candidate row's governance fields
-- directly so a permitted draft remains returnable to its Analyst author.
create or replace function public.can_read_kpi_definition_row(
  p_tenant_id uuid,
  p_approval_status text,
  p_audience_roles public.app_role[]
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
      from public.tenant_memberships membership
      where membership.tenant_id = p_tenant_id
        and membership.user_id = public.current_user_id()
        and membership.status = 'active'
        and (
          (p_approval_status = 'approved' and membership.role = any(p_audience_roles))
          or membership.role in ('company_admin', 'analyst')
          or public.is_platform_admin()
        )
    )
$$;

create or replace function public.can_read_kpi_value(
  p_tenant_id uuid,
  p_kpi_definition_id uuid,
  p_org_node_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    public.can_read_kpi_definition(p_tenant_id, p_kpi_definition_id)
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

alter table public.governed_datasets enable row level security;
alter table public.governed_dataset_fields enable row level security;
alter table public.kpi_definitions enable row level security;
alter table public.kpi_values enable row level security;

create policy "governed datasets: permitted reads"
on public.governed_datasets for select
using (public.can_read_governed_dataset(tenant_id, id));

create policy "governed datasets: selected tenant governor inserts"
on public.governed_datasets for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
);

create policy "governed datasets: selected tenant governor updates"
on public.governed_datasets for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and updated_by = public.current_user_id()
);

create policy "governed datasets: selected tenant governor deletes"
on public.governed_datasets for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and status = 'draft'
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "governed dataset fields: permitted reads"
on public.governed_dataset_fields for select
using (public.can_read_governed_dataset(tenant_id, dataset_id));

create policy "governed dataset fields: selected tenant governor writes"
on public.governed_dataset_fields for all
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

create policy "kpi definitions: permitted reads"
on public.kpi_definitions for select
using (public.can_read_kpi_definition_row(tenant_id, approval_status, audience_roles));

create policy "kpi definitions: selected tenant governor inserts"
on public.kpi_definitions for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and approval_status = 'draft'
  and approved_by is null
  and approved_at is null
  and created_by = public.current_user_id()
);

create policy "kpi definitions: selected tenant governor updates drafts"
on public.kpi_definitions for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and approval_status = 'draft'
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and (
    (approval_status = 'draft' and approved_by is null and approved_at is null)
    or (
      approval_status = 'approved'
      and (public.is_company_admin(tenant_id) or public.is_platform_admin())
      and approved_by = public.current_user_id()
      and approved_at is not null
    )
    or (
      approval_status = 'rejected'
      and (public.is_company_admin(tenant_id) or public.is_platform_admin())
      and approved_by is null
      and approved_at is null
    )
  )
);

create policy "kpi definitions: selected tenant governor deletes drafts"
on public.kpi_definitions for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and approval_status = 'draft'
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "kpi values: hierarchy and audience scoped reads"
on public.kpi_values for select
using (public.can_read_kpi_value(tenant_id, kpi_definition_id, org_node_id));

create policy "kpi values: selected tenant governor inserts"
on public.kpi_values for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and calculated_by = public.current_user_id()
);

create policy "kpi values: selected tenant governor updates"
on public.kpi_values for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and calculated_by = public.current_user_id()
);

create policy "kpi values: selected tenant governor deletes"
on public.kpi_values for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

revoke execute on function public.is_kpi_governor(uuid) from public;
revoke execute on function public.can_read_governed_dataset(uuid, uuid) from public;
revoke execute on function public.can_read_kpi_definition(uuid, uuid) from public;
revoke execute on function public.can_read_kpi_definition_row(uuid, text, public.app_role[]) from public;
revoke execute on function public.can_read_kpi_value(uuid, uuid, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.is_kpi_governor(uuid) to app_user';
    execute 'grant execute on function public.can_read_governed_dataset(uuid, uuid) to app_user';
    execute 'grant execute on function public.can_read_kpi_definition(uuid, uuid) to app_user';
    execute 'grant execute on function public.can_read_kpi_definition_row(uuid, text, public.app_role[]) to app_user';
    execute 'grant execute on function public.can_read_kpi_value(uuid, uuid, uuid) to app_user';
  end if;
end
$$;
