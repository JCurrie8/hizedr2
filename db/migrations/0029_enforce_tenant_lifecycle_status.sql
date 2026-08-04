-- Tenant suspension must be an enforcement boundary, not a label in the
-- Platform Admin UI. Bind every core membership/scope authority helper to an
-- active tenant so a suspended tenant fails closed even if future server code
-- accidentally reuses a stale tenant context.

create or replace function public.current_user_tenant_ids()
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.tenant_id), array[]::uuid[])
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id and t.status = 'active'
  where m.user_id = public.current_user_id() and m.status = 'active'
$$;

create or replace function public.current_user_has_tenant_access(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id and t.status = 'active'
    where m.tenant_id = p_tenant_id
      and m.user_id = public.current_user_id()
      and m.status = 'active'
  )
$$;

create or replace function public.is_active_tenant_member(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.current_user_has_tenant_access(p_tenant_id)
$$;

create or replace function public.is_company_admin(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id and t.status = 'active'
    where m.user_id = public.current_user_id()
      and m.tenant_id = p_tenant_id
      and m.role = 'company_admin'
      and m.status = 'active'
  )
$$;

create or replace function public.current_user_scope_paths()
returns public.ltree[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(v.path), array[]::public.ltree[])
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id and t.status = 'active'
  join public.membership_scopes s on s.membership_id = m.id
  join public.org_node_versions v on v.org_node_id = s.org_node_id
    and v.tenant_id = m.tenant_id
    and v.valid_from <= current_date and (v.valid_to is null or v.valid_to > current_date)
  where m.user_id = public.current_user_id()
    and m.status = 'active'
    and m.tenant_id = public.current_tenant_id()
$$;

create or replace function public.get_membership_for_slug(p_profile_id uuid, p_slug text)
returns table (tenant_id uuid, tenant_name text, branding jsonb, timezone text, role public.app_role)
language sql stable security definer set search_path = '' as $$
  select t.id, t.name, t.branding, t.timezone, m.role
  from public.tenants t
  join public.tenant_memberships m on m.tenant_id = t.id
  where t.slug = p_slug
    and t.status = 'active'
    and m.user_id = p_profile_id
    and m.status = 'active'
$$;

revoke execute on function public.current_user_tenant_ids() from public;
revoke execute on function public.current_user_has_tenant_access(uuid) from public;
revoke execute on function public.is_active_tenant_member(uuid) from public;
revoke execute on function public.is_company_admin(uuid) from public;
revoke execute on function public.current_user_scope_paths() from public;
revoke execute on function public.get_membership_for_slug(uuid, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    grant execute on function public.current_user_tenant_ids() to app_user;
    grant execute on function public.current_user_has_tenant_access(uuid) to app_user;
    grant execute on function public.is_active_tenant_member(uuid) to app_user;
    grant execute on function public.is_company_admin(uuid) to app_user;
    grant execute on function public.current_user_scope_paths() to app_user;
    grant execute on function public.get_membership_for_slug(uuid, text) to app_user;
  end if;
end
$$;
