-- EPIC-06/07 (PULSE-004): the governed contract that turns Connect's
-- operator-only curated records into the permission-safe projections added in
-- 0031. A rule names the dataset fields that may leave the Connect boundary;
-- the trigger below re-checks every one of them against the governed field
-- catalogue, so a later change to a field's sensitivity invalidates the rule
-- rather than silently continuing to publish it.

-- Publishing a dataset from the application (rather than a seed script) is the
-- first INSERT ... RETURNING against governed_datasets, which evaluates the
-- table's SELECT policy. The id-based helper self-queries governed_datasets and
-- cannot see the candidate row in the statement snapshot, so evaluate the
-- governance fields directly — the same correction migration 0032 made for
-- governed dimensions. The id-based helper stays: the dataset-field policy
-- still uses it, and that one is never evaluated against an unsaved row.
create or replace function public.can_read_governed_dataset_row(
  p_tenant_id uuid,
  p_status text
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and (
      p_status = 'published'
      or public.is_kpi_governor(p_tenant_id)
      or public.is_platform_admin()
    )
$$;

drop policy "governed datasets: permitted reads" on public.governed_datasets;

create policy "governed datasets: permitted reads"
on public.governed_datasets for select
using (public.can_read_governed_dataset_row(tenant_id, status));

revoke execute on function public.can_read_governed_dataset_row(uuid, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.can_read_governed_dataset_row(uuid, text) to app_user';
  end if;
end
$$;

-- A governed field key is a stable snake_case business name, while curated
-- records keep the pipeline's own target column name. Record the origin so a
-- projection reads the correct curated key without guessing at a transform.
alter table public.governed_dataset_fields
  add column source_field text
    check (source_field is null or length(trim(source_field)) between 1 and 200);

create table public.governed_record_projection_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dataset_id uuid not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- Curated value matched against org_nodes.code to place the record in the
  -- hierarchy. A record whose code matches nothing is never projected.
  org_code_field_key text not null,
  -- Required: without a record timestamp a projection cannot be attributed to
  -- a KPI value's reporting period, and unattributed records must not appear
  -- under an aggregate they may not belong to.
  occurred_at_field_key text not null,
  measure_field_key text,
  projected_field_keys text[] not null
    check (cardinality(projected_field_keys) between 1 and 25),
  max_records integer not null default 5000 check (max_records between 100 and 50000),
  last_projected_at timestamptz,
  last_projected_record_count integer not null default 0
    check (last_projected_record_count >= 0),
  last_unmatched_record_count integer not null default 0
    check (last_unmatched_record_count >= 0),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dataset_id),
  unique (id, tenant_id),
  foreign key (dataset_id, tenant_id)
    references public.governed_datasets(id, tenant_id) on delete cascade
);

create index governed_record_projection_rules_status_idx
  on public.governed_record_projection_rules (tenant_id, status, dataset_id);

create or replace function public.validate_governed_record_projection_rule()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  duplicate_count integer;
  invalid_key text;
begin
  select count(*) - count(distinct projected_key)
    into duplicate_count
    from unnest(new.projected_field_keys) as projected(projected_key);
  if duplicate_count > 0 then
    raise exception 'Projected fields must be unique';
  end if;

  select projected.projected_key into invalid_key
    from unnest(new.projected_field_keys) as projected(projected_key)
   where not exists (
     select 1
       from public.governed_dataset_fields field
      where field.tenant_id = new.tenant_id
        and field.dataset_id = new.dataset_id
        and field.field_key = projected.projected_key
        and not field.is_sensitive
   )
   limit 1;
  if invalid_key is not null then
    raise exception 'Projected field % is not a non-sensitive governed field', invalid_key;
  end if;

  if not exists (
    select 1
      from public.governed_dataset_fields field
     where field.tenant_id = new.tenant_id
       and field.dataset_id = new.dataset_id
       and field.field_key = new.org_code_field_key
       and not field.is_sensitive
       and field.data_type = 'text'
  ) then
    raise exception 'Organisation code field must be a non-sensitive text field';
  end if;

  if not exists (
    select 1
      from public.governed_dataset_fields field
     where field.tenant_id = new.tenant_id
       and field.dataset_id = new.dataset_id
       and field.field_key = new.occurred_at_field_key
       and not field.is_sensitive
       and field.data_type in ('date', 'timestamp')
  ) then
    raise exception 'Record date field must be a non-sensitive date or timestamp field';
  end if;

  -- The drill-through reads each record's contribution out of the projected
  -- payload, so a contribution field that is not itself projected would make
  -- every lineage row null.
  if new.measure_field_key is not null
     and not (new.measure_field_key = any(new.projected_field_keys)) then
    raise exception 'Contribution field must also be a projected field';
  end if;

  if new.measure_field_key is not null and not exists (
    select 1
      from public.governed_dataset_fields field
     where field.tenant_id = new.tenant_id
       and field.dataset_id = new.dataset_id
       and field.field_key = new.measure_field_key
       and not field.is_sensitive
       and field.data_type in ('integer', 'decimal')
  ) then
    raise exception 'Contribution field must be a non-sensitive numeric field';
  end if;

  return new;
end
$$;

create trigger validate_governed_record_projection_rule_before_write
before insert or update of tenant_id, dataset_id, org_code_field_key,
  occurred_at_field_key, measure_field_key, projected_field_keys
on public.governed_record_projection_rules
for each row execute function public.validate_governed_record_projection_rule();

alter table public.governed_record_projection_rules enable row level security;

-- Projection rules are operator configuration, not reporting content: ordinary
-- members read the resulting projections through 0031's lineage policy, never
-- this table. Keep these predicates complete and per-command — a broader
-- permissive read policy alongside them would OR into the 0006/0011 leak shape.
create policy "record projection rules: selected tenant governor reads"
on public.governed_record_projection_rules for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "record projection rules: selected tenant governor inserts"
on public.governed_record_projection_rules for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
);

create policy "record projection rules: selected tenant governor updates"
on public.governed_record_projection_rules for update
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

create policy "record projection rules: selected tenant governor deletes"
on public.governed_record_projection_rules for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

revoke execute on function public.validate_governed_record_projection_rule() from public;
