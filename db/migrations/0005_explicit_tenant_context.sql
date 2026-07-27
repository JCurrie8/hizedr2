-- Fixes a real gap: current_tenant_id() previously derived "the" tenant
-- by grabbing any one active membership (`limit 1`). That's wrong for
-- anyone with memberships in more than one tenant — which the blueprint
-- requires supporting (Hized consultancy staff get an ordinary
-- tenant_membership per client tenant, section 3.2/8.2). With `limit 1`,
-- which tenant such a user actually gets scoped to on a given request is
-- arbitrary, and current_user_scope_paths() would mix org-hierarchy paths
-- from multiple tenants together — a real cross-tenant leak risk if two
-- tenants ever happen to share an ltree path shape.
--
-- Fix: the app explicitly sets a SECOND session variable,
-- app.current_tenant_id, only after validating (in getAuthContext(), not
-- here) that the caller has an active membership in the hostname-resolved
-- tenant. current_tenant_id() now just reads that variable instead of
-- guessing. current_user_scope_paths() is additionally scoped to that
-- same tenant.

create or replace function public.current_tenant_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.current_tenant_id', true), '')::uuid
$$;

create or replace function public.current_user_scope_paths()
returns ltree[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(v.path), array[]::ltree[])
  from public.tenant_memberships m
  join public.membership_scopes s on s.membership_id = m.id
  join public.org_node_versions v on v.org_node_id = s.org_node_id
    and v.valid_from <= current_date and (v.valid_to is null or v.valid_to >= current_date)
  where m.user_id = public.current_user_id() and m.status = 'active'
    and m.tenant_id = public.current_tenant_id()
$$;
