-- Company Admins must still be able to identify a suspended member in the
-- access-management screen. The original co-member profile policy only
-- exposes profiles whose membership is active, so suspending someone made
-- their name disappear immediately.
--
-- This additional SELECT policy is deliberately bound to BOTH the explicit
-- current tenant context and an active Company Admin membership. It does not
-- let an admin of several tenants mix those tenants in one request.

create policy "profiles: current tenant company admin sees all members"
on public.profiles for select
using (
  exists (
    select 1
    from public.tenant_memberships mine
    join public.tenant_memberships theirs on theirs.tenant_id = mine.tenant_id
    where mine.user_id = public.current_user_id()
      and mine.status = 'active'
      and mine.role = 'company_admin'
      and mine.tenant_id = public.current_tenant_id()
      and theirs.user_id = profiles.id
  )
);
