-- Fixes another real bug surfaced by rls.test.ts, distinct from 0006's:
--
-- "tenants: select if member or platform admin" queries
-- public.tenant_memberships directly inside its USING clause. RLS
-- policies (unlike SECURITY DEFINER functions) run with the querying
-- role's own privileges — so that nested read is itself subject to
-- tenant_memberships' RLS, which requires app.current_tenant_id to
-- already be set. But "which tenants am I a member of" (a tenant
-- picker, or the first step of resolving a hostname) is exactly the
-- case where you don't have a tenant pre-selected yet: chicken-and-egg,
-- same shape as the problems 0004 and 0005 already solved, just one
-- layer removed (a policy referencing another RLS table, rather than an
-- app query running with no context at all).
--
-- Fix: a SECURITY DEFINER function for "list of tenant_ids the current
-- user actively belongs to" (bypasses tenant_memberships' RLS
-- internally, same mechanism as is_company_admin()), and the tenants
-- policy now checks membership through that instead of a raw subquery.

create or replace function public.current_user_tenant_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(tenant_id), array[]::uuid[])
  from public.tenant_memberships
  where user_id = public.current_user_id() and status = 'active'
$$;

drop policy "tenants: select if member or platform admin" on public.tenants;
create policy "tenants: select if member or platform admin"
on public.tenants for select
using (
  public.is_platform_admin()
  or tenants.id = any(public.current_user_tenant_ids())
);
