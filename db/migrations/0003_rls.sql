-- RLS helper functions + policies for every Phase 0 tenant/identity table.
--
-- Isolation mechanism: the app sets a Postgres session variable
-- (app.current_user_id) per request, inside a transaction, via
-- withUserContext() (see apps/web/src/server/db). If that variable is
-- never set — e.g. a query run outside the wrapper — current_user_id()
-- returns null and every policy below resolves to "no access": this
-- fails closed, not open.
--
-- IMPORTANT: the Postgres role the app connects as must NOT have
-- BYPASSRLS or be a superuser, or every policy here is silently skipped.
-- Neon's default connection role does not have BYPASSRLS, but this must
-- be re-confirmed if the connection role/user is ever changed.

create or replace function public.current_user_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create or replace function public.current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from public.tenant_memberships
  where user_id = public.current_user_id() and status = 'active' limit 1
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = public.current_user_id())
$$;

create or replace function public.current_user_scope_paths()
returns ltree[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(v.path), array[]::ltree[])
  from public.tenant_memberships m
  join public.membership_scopes s on s.membership_id = m.id
  join public.org_node_versions v on v.org_node_id = s.org_node_id
    and v.valid_from <= current_date and (v.valid_to is null or v.valid_to >= current_date)
  where m.user_id = public.current_user_id() and m.status = 'active'
$$;

create or replace function public.is_company_admin(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_memberships m
    where m.user_id = public.current_user_id() and m.tenant_id = p_tenant_id
      and m.role = 'company_admin' and m.status = 'active'
  )
$$;

-- tenants: visible if you have any active membership there, or are a
-- platform admin. Only a platform admin can create/update tenant rows in
-- Phase 0 (tenant provisioning is a Hized-internal action, not
-- self-serve).
alter table public.tenants enable row level security;

create policy "tenants: select if member or platform admin"
on public.tenants for select
using (
  public.is_platform_admin()
  or exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = tenants.id and m.user_id = public.current_user_id() and m.status = 'active'
  )
);

create policy "tenants: platform admin write"
on public.tenants for all
using (public.is_platform_admin())
with check (public.is_platform_admin());

-- profiles: tenant-agnostic identity, so isolation isn't by tenant_id —
-- a profile is visible to itself, to platform admins, or to anyone who
-- shares an active tenant membership with that profile (so a colleague's
-- name/avatar resolve in shared UI, e.g. "managed by X").
alter table public.profiles enable row level security;

create policy "profiles: select self, platform admin, or tenant co-member"
on public.profiles for select
using (
  id = public.current_user_id()
  or public.is_platform_admin()
  or exists (
    select 1 from public.tenant_memberships mine
    join public.tenant_memberships theirs on theirs.tenant_id = mine.tenant_id
    where mine.user_id = public.current_user_id() and mine.status = 'active'
      and theirs.user_id = profiles.id and theirs.status = 'active'
  )
);

create policy "profiles: update self only"
on public.profiles for update
using (id = public.current_user_id())
with check (id = public.current_user_id());

-- platform_admins: only visible/writable by existing platform admins.
-- The first platform admin must be seeded directly (a migration/script
-- with a trusted connection), not through the app — this is the
-- deliberate bootstrap exception; see docs/runbooks.
alter table public.platform_admins enable row level security;

create policy "platform_admins: platform admin only"
on public.platform_admins for all
using (public.is_platform_admin())
with check (public.is_platform_admin());

-- tenant_memberships: standard tenant isolation, writable only by that
-- tenant's company_admin (or a platform admin).
alter table public.tenant_memberships enable row level security;

create policy "tenant_memberships: tenant isolation select"
on public.tenant_memberships for select
using (tenant_id = public.current_tenant_id() or public.is_platform_admin());

create policy "tenant_memberships: company_admin write"
on public.tenant_memberships for all
using (public.is_company_admin(tenant_id) or public.is_platform_admin())
with check (public.is_company_admin(tenant_id) or public.is_platform_admin());

-- org_nodes: standard tenant isolation for the stable-identity row itself
-- (no org-scope filtering here — the actual "which subtree can you see"
-- check lives on org_node_versions, since that's what carries the path).
alter table public.org_nodes enable row level security;

create policy "org_nodes: tenant isolation select"
on public.org_nodes for select
using (tenant_id = public.current_tenant_id() or public.is_platform_admin());

create policy "org_nodes: company_admin write"
on public.org_nodes for all
using (public.is_company_admin(tenant_id) or public.is_platform_admin())
with check (public.is_company_admin(tenant_id) or public.is_platform_admin());

-- org_node_versions: tenant isolation + org-scope subtree filtering.
-- This is the primary drill-down / row-level security boundary (ORG-003).
alter table public.org_node_versions enable row level security;

create policy "org_node_versions: tenant isolation + org scope select"
on public.org_node_versions for select
using (
  tenant_id = public.current_tenant_id()
  and (
    public.is_platform_admin()
    or exists (
      select 1 from unnest(public.current_user_scope_paths()) as scope(p)
      where org_node_versions.path <@ scope.p
    )
  )
);

create policy "org_node_versions: company_admin write"
on public.org_node_versions for all
using (public.is_company_admin(tenant_id) or public.is_platform_admin())
with check (public.is_company_admin(tenant_id) or public.is_platform_admin());

-- membership_scopes: no tenant_id column of its own (join table) — scope
-- via the owning membership's tenant.
alter table public.membership_scopes enable row level security;

create policy "membership_scopes: tenant isolation via membership"
on public.membership_scopes for select
using (
  exists (
    select 1 from public.tenant_memberships m
    where m.id = membership_scopes.membership_id
      and (m.tenant_id = public.current_tenant_id() or public.is_platform_admin())
  )
);

create policy "membership_scopes: company_admin write"
on public.membership_scopes for all
using (
  exists (
    select 1 from public.tenant_memberships m
    where m.id = membership_scopes.membership_id
      and (public.is_company_admin(m.tenant_id) or public.is_platform_admin())
  )
)
with check (
  exists (
    select 1 from public.tenant_memberships m
    where m.id = membership_scopes.membership_id
      and (public.is_company_admin(m.tenant_id) or public.is_platform_admin())
  )
);

-- invitations: standard tenant isolation, writable only by company_admin.
alter table public.invitations enable row level security;

create policy "invitations: tenant isolation select"
on public.invitations for select
using (tenant_id = public.current_tenant_id() or public.is_platform_admin());

create policy "invitations: company_admin write"
on public.invitations for all
using (public.is_company_admin(tenant_id) or public.is_platform_admin())
with check (public.is_company_admin(tenant_id) or public.is_platform_admin());

-- audit_log: readable only by that tenant's company_admin or a platform
-- admin (audit trails are sensitive, not general-employee visible).
-- Insert is broader — any active tenant member's action can produce an
-- audit row, or a platform-level action (tenant_id null) by a platform
-- admin. Update/delete already revoked from public in 0002.
alter table public.audit_log enable row level security;

create policy "audit_log: admin-only select"
on public.audit_log for select
using (
  public.is_platform_admin()
  or (tenant_id is not null and public.is_company_admin(tenant_id))
);

create policy "audit_log: tenant member or platform admin insert"
on public.audit_log for insert
with check (
  (tenant_id = public.current_tenant_id())
  or (tenant_id is null and public.is_platform_admin())
);
