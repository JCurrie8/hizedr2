-- Phase 0 security hardening following the Codex review recorded in
-- PROGRESS.md. This migration deliberately fails closed during deployment:
-- the old email-only invitation functions are removed, so signup requires
-- the token-aware application code shipped with this migration.

-- Effective-date intervals are half-open throughout the schema: [from, to).
create or replace function public.current_user_scope_paths()
returns public.ltree[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(v.path), array[]::public.ltree[])
  from public.tenant_memberships m
  join public.membership_scopes s on s.membership_id = m.id
  join public.org_node_versions v on v.org_node_id = s.org_node_id
    and v.tenant_id = m.tenant_id
    and v.valid_from <= current_date and (v.valid_to is null or v.valid_to > current_date)
  where m.user_id = public.current_user_id() and m.status = 'active'
    and m.tenant_id = public.current_tenant_id()
$$;

create or replace function public.is_active_tenant_member(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_memberships m
    where m.user_id = public.current_user_id()
      and m.tenant_id = p_tenant_id
      and m.status = 'active'
  )
$$;

-- Bind every audit row to the session actor. Platform admins may write
-- tenant or platform-level events; ordinary actors must be active in the
-- current tenant. The one non-member exception records a denied attempt.
drop policy "audit_log: tenant member or platform admin insert" on public.audit_log;
create policy "audit_log: tenant member or platform admin insert"
on public.audit_log for insert
with check (
  actor_user_id = public.current_user_id()
  and (
    public.is_platform_admin()
    or (
      tenant_id = public.current_tenant_id()
      and (
        public.is_active_tenant_member(tenant_id)
        or action = 'access.cross_tenant_denied'
      )
    )
  )
);

-- A pending invitation is authority only when the caller proves possession
-- of its high-entropy token. Email knowledge alone is not authorization.
create or replace function public.has_pending_invitation_by_token(
  p_email public.citext,
  p_token_hash text
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.invitations i
    where i.email = p_email
      and i.token_hash = p_token_hash
      and i.status = 'pending'
      and i.expires_at > now()
  )
$$;

-- Handles a newly-created Better Auth user and an already-authenticated user
-- accepting an invitation to another tenant. Email is resolved from Better
-- Auth's table, never trusted as a function argument.
create or replace function public.accept_invitation_by_token(
  p_auth_user_id text,
  p_token_hash text
)
returns table (profile_id uuid, tenant_id uuid, tenant_slug text)
language plpgsql security definer set search_path = '' as $$
declare
  v_invitation record;
  v_profile_id uuid;
  v_membership_id uuid;
  v_email public.citext;
  v_name text;
  v_tenant_slug text;
begin
  select u.email::public.citext, u.name
  into v_email, v_name
  from public."user" u
  where u.id = p_auth_user_id;

  if not found then
    raise exception 'authenticated user does not exist';
  end if;

  select i.id, i.tenant_id, i.role, i.org_node_id
  into v_invitation
  from public.invitations i
  where i.email = v_email
    and i.token_hash = p_token_hash
    and i.status = 'pending'
    and i.expires_at > now()
  for update;

  if not found then
    raise exception 'invitation is invalid, expired, or belongs to another email';
  end if;

  select p.id into v_profile_id
  from public.profiles p
  where p.auth_user_id = p_auth_user_id;

  if not found then
    insert into public.profiles (auth_user_id, full_name)
    values (p_auth_user_id, v_name)
    returning id into v_profile_id;
  end if;

  if exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = v_invitation.tenant_id and m.user_id = v_profile_id
  ) then
    raise exception 'user is already a member of this tenant';
  end if;

  if v_invitation.org_node_id is not null and not exists (
    select 1 from public.org_nodes n
    where n.id = v_invitation.org_node_id and n.tenant_id = v_invitation.tenant_id
  ) then
    raise exception 'invitation scope does not belong to its tenant';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, role, status)
  values (v_invitation.tenant_id, v_profile_id, v_invitation.role, 'active')
  returning id into v_membership_id;

  if v_invitation.org_node_id is not null then
    insert into public.membership_scopes (membership_id, org_node_id, is_primary)
    values (v_membership_id, v_invitation.org_node_id, true);
  end if;

  update public.invitations set status = 'accepted' where id = v_invitation.id;

  insert into public.audit_log (tenant_id, actor_user_id, action, target_type, target_id, metadata)
  values (
    v_invitation.tenant_id,
    v_profile_id,
    'invitation.accepted',
    'invitation',
    v_invitation.id::text,
    jsonb_build_object('role', v_invitation.role)
  );

  select t.slug into v_tenant_slug from public.tenants t where t.id = v_invitation.tenant_id;
  return query select v_profile_id, v_invitation.tenant_id, v_tenant_slug;
end;
$$;

drop function public.has_pending_invitation(public.citext);
drop function public.accept_invitation_by_email(text, public.citext);

-- RLS limits rows, not columns. Keep identity/staff attributes owner-only;
-- the runtime role may update only user-facing display fields.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'revoke update on public.profiles from app_user';
    execute 'grant update (full_name, avatar_url) on public.profiles to app_user';
  end if;
end
$$;

-- SECURITY DEFINER functions are privileged APIs. Remove PostgreSQL's
-- implicit PUBLIC execute grant and grant only the restricted runtime role.
alter function public.current_user_id() set search_path = '';
alter function public.current_tenant_id() set search_path = '';
alter function public.is_platform_admin() set search_path = '';
alter function public.is_company_admin(uuid) set search_path = '';
alter function public.current_user_tenant_ids() set search_path = '';
alter function public.get_profile_for_auth_user(text) set search_path = '';
alter function public.get_membership_for_slug(uuid, text) set search_path = '';
alter function public.get_tenant_id_by_slug(text) set search_path = '';
alter function public.find_invitation_preview(text) set search_path = '';

revoke execute on function public.current_user_id() from public;
revoke execute on function public.current_tenant_id() from public;
revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.is_company_admin(uuid) from public;
revoke execute on function public.current_user_scope_paths() from public;
revoke execute on function public.current_user_tenant_ids() from public;
revoke execute on function public.is_active_tenant_member(uuid) from public;
revoke execute on function public.get_profile_for_auth_user(text) from public;
revoke execute on function public.get_membership_for_slug(uuid, text) from public;
revoke execute on function public.get_tenant_id_by_slug(text) from public;
revoke execute on function public.find_invitation_preview(text) from public;
revoke execute on function public.has_pending_invitation_by_token(public.citext, text) from public;
revoke execute on function public.accept_invitation_by_token(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.current_user_id() to app_user';
    execute 'grant execute on function public.current_tenant_id() to app_user';
    execute 'grant execute on function public.is_platform_admin() to app_user';
    execute 'grant execute on function public.is_company_admin(uuid) to app_user';
    execute 'grant execute on function public.current_user_scope_paths() to app_user';
    execute 'grant execute on function public.current_user_tenant_ids() to app_user';
    execute 'grant execute on function public.is_active_tenant_member(uuid) to app_user';
    execute 'grant execute on function public.get_profile_for_auth_user(text) to app_user';
    execute 'grant execute on function public.get_membership_for_slug(uuid, text) to app_user';
    execute 'grant execute on function public.get_tenant_id_by_slug(text) to app_user';
    execute 'grant execute on function public.find_invitation_preview(text) to app_user';
    execute 'grant execute on function public.has_pending_invitation_by_token(public.citext, text) to app_user';
    execute 'grant execute on function public.accept_invitation_by_token(text, text) to app_user';
  end if;
end
$$;
