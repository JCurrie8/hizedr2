-- EPIC-06: complete the minimum governed-definition contract and make
-- approval/version rollover one narrow database transition. Analysts can
-- author drafts; only a selected-tenant Company Admin can publish one.

alter table public.kpi_definitions
  add column reviewer_name text,
  add column target_method text not null default 'period_specific'
    check (target_method in ('fixed', 'period_specific', 'inherited', 'employee_specific')),
  add column applicable_node_types text[] not null
    default array['company', 'division', 'function', 'department', 'region', 'site', 'team', 'employee'];

update public.kpi_definitions
set reviewer_name = owner_name
where reviewer_name is null;

alter table public.kpi_definitions
  alter column reviewer_name set not null,
  add constraint kpi_definitions_reviewer_name_check
    check (length(trim(reviewer_name)) > 0),
  add constraint kpi_definitions_applicable_node_types_check
    check (
      cardinality(applicable_node_types) > 0
      and applicable_node_types <@ array[
        'company', 'division', 'function', 'department', 'region', 'site', 'team', 'employee'
      ]::text[]
    );

-- Direct UPDATE can edit/reject a draft, but cannot publish it. Publishing
-- must use approve_kpi_definition_version(), which also closes the previous
-- approved version atomically so the partial unique index remains true.
drop policy "kpi definitions: selected tenant governor updates drafts"
  on public.kpi_definitions;

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
      approval_status = 'rejected'
      and (public.is_company_admin(tenant_id) or public.is_platform_admin())
      and approved_by is null
      and approved_at is null
    )
  )
);

create or replace function public.approve_kpi_definition_version(
  p_tenant_id uuid,
  p_definition_id uuid
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := public.current_user_id();
  v_candidate public.kpi_definitions%rowtype;
  v_previous public.kpi_definitions%rowtype;
begin
  if p_tenant_id is distinct from public.current_tenant_id()
     or v_actor_id is null
     or not public.current_user_has_tenant_access(p_tenant_id)
     or not public.is_company_admin(p_tenant_id) then
    raise exception 'Only a Company Admin in the selected tenant can approve a KPI definition.'
      using errcode = '42501';
  end if;

  select * into v_candidate
  from public.kpi_definitions definition
  where definition.tenant_id = p_tenant_id
    and definition.id = p_definition_id
    and definition.approval_status = 'draft'
  for update;

  if not found then
    raise exception 'KPI draft not found.' using errcode = 'P0002';
  end if;

  select * into v_previous
  from public.kpi_definitions definition
  where definition.tenant_id = p_tenant_id
    and definition.kpi_key = v_candidate.kpi_key
    and definition.approval_status = 'approved'
    and definition.valid_to is null
    and definition.id <> v_candidate.id
  for update;

  if found then
    if v_candidate.version_number <= v_previous.version_number then
      raise exception 'A replacement KPI version must increment the approved version.'
        using errcode = '23514';
    end if;
    if v_candidate.valid_from <= v_previous.valid_from then
      raise exception 'A replacement KPI version must start after the current version.'
        using errcode = '23514';
    end if;

    update public.kpi_definitions
    set valid_to = v_candidate.valid_from
    where id = v_previous.id;
  end if;

  update public.kpi_definitions
  set approval_status = 'approved',
      approved_by = v_actor_id,
      approved_at = now()
  where id = v_candidate.id;

  return v_candidate.id;
end
$$;

revoke execute on function public.approve_kpi_definition_version(uuid, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.approve_kpi_definition_version(uuid, uuid) to app_user';
  end if;
end
$$;
