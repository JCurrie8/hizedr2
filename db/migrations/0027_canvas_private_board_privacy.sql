-- A KPI governor administers Pulse definitions and templates; that authority
-- must not silently grant access to another member's private Canvas work.
-- Keep Pulse draft visibility for governors, while Canvas requires ownership
-- or an explicit published-board grant.

create or replace function public.can_read_analytics_view_row(
  p_tenant_id uuid,
  p_view_id uuid,
  p_surface text,
  p_status text,
  p_visibility text,
  p_owner_user_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    public.can_use_analytics_surface(p_tenant_id, p_surface)
    and (
      p_owner_user_id = public.current_user_id()
      or (p_surface = 'pulse' and public.is_kpi_governor(p_tenant_id))
      or (
        p_status = 'published'
        and (
          p_visibility = 'tenant'
          or (p_visibility = 'restricted' and public.has_analytics_view_grant(p_tenant_id, p_view_id, 'view'))
        )
      )
    )
$$;

create or replace function public.can_edit_analytics_view(p_tenant_id uuid, p_view_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.analytics_views view_row
    where view_row.tenant_id = p_tenant_id
      and view_row.id = p_view_id
      and public.can_use_analytics_surface(p_tenant_id, view_row.surface)
      and (
        (view_row.surface = 'pulse' and public.is_kpi_governor(p_tenant_id))
        or (view_row.surface = 'canvas' and view_row.owner_user_id = public.current_user_id())
        or (view_row.surface = 'canvas' and public.has_analytics_view_grant(p_tenant_id, p_view_id, 'edit'))
      )
  )
$$;

revoke execute on function public.can_read_analytics_view_row(uuid, uuid, text, text, text, uuid) from public;
revoke execute on function public.can_edit_analytics_view(uuid, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.can_read_analytics_view_row(uuid, uuid, text, text, text, uuid) to app_user';
    execute 'grant execute on function public.can_edit_analytics_view(uuid, uuid) to app_user';
  end if;
end
$$;
