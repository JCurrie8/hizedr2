-- INSERT ... RETURNING evaluates the table's SELECT policy. An id-based
-- helper that self-queries governed_dimensions may not see the candidate row
-- in the statement snapshot, so evaluate its governance fields directly.

create or replace function public.can_read_governed_dimension_row(
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

drop policy "governed dimensions: permitted reads" on public.governed_dimensions;

create policy "governed dimensions: permitted reads"
on public.governed_dimensions for select
using (public.can_read_governed_dimension_row(tenant_id, status));

revoke execute on function public.can_read_governed_dimension_row(uuid, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.can_read_governed_dimension_row(uuid, text) to app_user';
  end if;
end
$$;
