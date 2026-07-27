-- Two more SECURITY DEFINER lookups, same chicken-and-egg shape as
-- 0004/0007: resolving "which profile is this authenticated session" and
-- "does this profile have active access to this tenant slug" both need
-- to read RLS-protected tables before any session context exists.
--
-- IMPORTANT — the actual trust boundary this creates: these functions
-- take a profile/user id as a plain parameter and return data about
-- that id, bypassing RLS. They are safe ONLY because every caller in
-- this codebase is trusted server code that always derives the id
-- fresh from Better Auth's own cookie-verified session
-- (auth.api.getSession()) — never from client-supplied input. Unlike
-- Supabase's auth.uid(), which is cryptographically tied to a verified
-- JWT at the database layer itself, Neon has no equivalent: the "who is
-- this session variable for" step is a trusted operation performed once
-- by our own server code, not something the database itself can verify
-- independently. RLS still protects every ordinary tenant-scoped query
-- after that point — this is specifically about the identity-resolution
-- step, not a general weakening of the isolation model. See
-- apps/web/src/server/domains/access-control/auth-context.ts, which is
-- the ONLY place these functions should ever be called from.

create or replace function public.get_profile_for_auth_user(p_auth_user_id text)
returns table (profile_id uuid, full_name text, is_hized_staff boolean, is_platform_admin boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.is_hized_staff, (pa.user_id is not null)
  from public.profiles p
  left join public.platform_admins pa on pa.user_id = p.id
  where p.auth_user_id = p_auth_user_id
$$;

create or replace function public.get_membership_for_slug(p_profile_id uuid, p_slug text)
returns table (tenant_id uuid, tenant_name text, branding jsonb, timezone text, role public.app_role)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.branding, t.timezone, m.role
  from public.tenants t
  join public.tenant_memberships m on m.tenant_id = t.id
  where t.slug = p_slug and m.user_id = p_profile_id and m.status = 'active'
$$;
