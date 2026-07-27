-- Invite-gated signup provisioning.
--
-- Problem: Better Auth's signup hooks need to check/write public.invitations
-- at the moment a new user is created — before any tenant_membership (and
-- therefore any session context / current_tenant_id()) exists. Run through
-- the ordinary app_user + RLS path, that's a chicken-and-egg: with no
-- session variable set, every RLS policy resolves to "no access", so even
-- a legitimately invited signup would be silently rejected.
--
-- Fix: two SECURITY DEFINER functions, following the same pattern as
-- current_tenant_id()/is_platform_admin() in 0003_rls.sql — they run with
-- the privileges of their owner (neondb_owner, which has BYPASSRLS), so
-- they see the real invitations table regardless of the caller's session
-- state. app_user gets EXECUTE (already covered by the default-privileges
-- grant in setup-app-role.mjs) but no direct table access beyond what RLS
-- already permits — the ONLY way to create a public.profiles row is
-- through accept_invitation_by_email(), which makes "provisioning is
-- invite-only" a database-enforced invariant, not just an app convention.
-- There is deliberately no other INSERT policy on public.profiles.

create or replace function public.has_pending_invitation(p_email citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.invitations
    where email = p_email and status = 'pending' and expires_at > now()
  )
$$;

-- Read-only preview for the public /invite/[token] page, which also runs
-- before the visitor is authenticated. Only returns non-sensitive fields
-- (tenant name, email, role) for a still-valid pending token — knowing
-- the token already implies the right to see this much.
create or replace function public.find_invitation_preview(p_token_hash text)
returns table (invitation_id uuid, tenant_id uuid, tenant_name text, email citext, role public.app_role, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.tenant_id, t.name, i.email, i.role, i.expires_at
  from public.invitations i
  join public.tenants t on t.id = i.tenant_id
  where i.token_hash = p_token_hash and i.status = 'pending' and i.expires_at > now()
$$;

create or replace function public.accept_invitation_by_email(p_auth_user_id text, p_email citext)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invitation record;
  v_profile_id uuid;
  v_membership_id uuid;
begin
  select id, tenant_id, role, org_node_id into v_invitation
  from public.invitations
  where email = p_email and status = 'pending' and expires_at > now()
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'no pending invitation for %', p_email;
  end if;

  insert into public.profiles (auth_user_id)
  values (p_auth_user_id)
  returning id into v_profile_id;

  insert into public.tenant_memberships (tenant_id, user_id, role, status)
  values (v_invitation.tenant_id, v_profile_id, v_invitation.role, 'active')
  returning id into v_membership_id;

  if v_invitation.org_node_id is not null then
    insert into public.membership_scopes (membership_id, org_node_id, is_primary)
    values (v_membership_id, v_invitation.org_node_id, true);
  end if;

  update public.invitations set status = 'accepted' where id = v_invitation.id;

  return v_profile_id;
end;
$$;
