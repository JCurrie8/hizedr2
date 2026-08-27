-- A SQL analysis may be authored by an Analyst and later rerun/certified by a
-- Company Admin. Preserve immutable authorship while requiring the current
-- actor only in updated_by; a single FOR ALL policy incorrectly required every
-- updater to equal created_by.

drop policy "SQL analyses: selected tenant governors" on public.sql_analysis_queries;

create policy "SQL analyses: selected tenant governor reads"
on public.sql_analysis_queries for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);

create policy "SQL analyses: selected tenant governor inserts"
on public.sql_analysis_queries for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
);

create policy "SQL analyses: selected tenant governor updates"
on public.sql_analysis_queries for update
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

create policy "SQL analyses: selected tenant governor deletes"
on public.sql_analysis_queries for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_kpi_governor(tenant_id) or public.is_platform_admin())
);
