-- Fixes a real cross-tenant leak surfaced by packages/testing/src/rls.test.ts.
--
-- The "*: company_admin write" policies use `for all`, which Postgres
-- also applies to SELECT (permissive policies are OR'd together per
-- command). Their USING clause was `is_company_admin(tenant_id)` alone —
-- checking the ROW's own tenant_id against the caller's admin status for
-- THAT tenant, entirely independent of app.current_tenant_id. For a user
-- who is company_admin of more than one tenant (Hized consultancy staff,
-- by design — see 0003_rls.sql's tenant_memberships comment), this let
-- them read/write every tenant they administer at once, regardless of
-- which tenant the current request/session was actually scoped to.
--
-- Fix: every write policy now ALSO requires the row's tenant to equal
-- current_tenant_id(), same as the read policies. A multi-tenant
-- company_admin is still only ever scoped to the one tenant their session
-- explicitly set — exactly the boundary getAuthContext() is responsible
-- for validating before calling withUserContext().

drop policy "tenant_memberships: company_admin write" on public.tenant_memberships;
create policy "tenant_memberships: company_admin write"
on public.tenant_memberships for all
using (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()))
with check (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()));

drop policy "org_nodes: company_admin write" on public.org_nodes;
create policy "org_nodes: company_admin write"
on public.org_nodes for all
using (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()))
with check (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()));

drop policy "org_node_versions: company_admin write" on public.org_node_versions;
create policy "org_node_versions: company_admin write"
on public.org_node_versions for all
using (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()))
with check (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()));

drop policy "membership_scopes: company_admin write" on public.membership_scopes;
create policy "membership_scopes: company_admin write"
on public.membership_scopes for all
using (
  exists (
    select 1 from public.tenant_memberships m
    where m.id = membership_scopes.membership_id
      and m.tenant_id = public.current_tenant_id()
      and (public.is_company_admin(m.tenant_id) or public.is_platform_admin())
  )
)
with check (
  exists (
    select 1 from public.tenant_memberships m
    where m.id = membership_scopes.membership_id
      and m.tenant_id = public.current_tenant_id()
      and (public.is_company_admin(m.tenant_id) or public.is_platform_admin())
  )
);

drop policy "invitations: company_admin write" on public.invitations;
create policy "invitations: company_admin write"
on public.invitations for all
using (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()))
with check (tenant_id = public.current_tenant_id() and (public.is_company_admin(tenant_id) or public.is_platform_admin()));

-- tenants' own write policy is platform-admin-only (is_platform_admin()
-- doesn't take a tenant_id, so it isn't affected by this class of bug),
-- and audit_log's insert policy already requires tenant_id =
-- current_tenant_id() explicitly — both already correct, left unchanged.
