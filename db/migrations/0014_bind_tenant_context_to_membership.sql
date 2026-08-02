-- Defense in depth for the trusted server-to-database handoff.
--
-- getAuthContext() validates that the Better Auth identity has an active
-- membership before withUserContext() sets app.current_tenant_id. The
-- database previously trusted that pairing completely: several SELECT
-- policies checked only row.tenant_id = current_tenant_id(). A future
-- server bug that paired a real profile with the wrong tenant context
-- could therefore expose tenant_memberships, org_nodes, or invitations.
--
-- Bind those ordinary read policies to active membership as well. The
-- deliberately narrow access.cross_tenant_denied audit write still works:
-- its INSERT policy remains context-bound and writeAuditLog controls the
-- only statement in that transaction.

create or replace function public.current_user_has_tenant_access(p_tenant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = public.current_user_id()
      and m.status = 'active'
  )
$$;

drop policy "tenant_memberships: tenant isolation select" on public.tenant_memberships;
create policy "tenant_memberships: tenant isolation select"
on public.tenant_memberships for select
using (
  public.is_platform_admin()
  or (
    tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(tenant_id)
  )
);

drop policy "org_nodes: tenant isolation select" on public.org_nodes;
create policy "org_nodes: tenant isolation select"
on public.org_nodes for select
using (
  public.is_platform_admin()
  or (
    tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(tenant_id)
  )
);

drop policy "invitations: tenant isolation select" on public.invitations;
create policy "invitations: tenant isolation select"
on public.invitations for select
using (
  public.is_platform_admin()
  or (
    tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(tenant_id)
  )
);

revoke execute on function public.current_user_has_tenant_access(uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.current_user_has_tenant_access(uuid) to app_user';
  end if;
end
$$;
