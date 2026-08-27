-- Canvas creation is a product capability, not an application role. Any
-- company member can be a viewer or creator independently of whether they are
-- an End user, Manager, Analyst or Company Admin. Existing members retain the
-- democratised behaviour and are backfilled as creators.

alter table public.tenant_memberships
  add column canvas_role text not null default 'creator'
    check (canvas_role in ('viewer', 'creator'));

create index tenant_memberships_canvas_creator_idx
  on public.tenant_memberships (tenant_id, user_id)
  where status = 'active' and canvas_role = 'creator';

create or replace function public.can_create_canvas(p_tenant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and exists (
      select 1
        from public.tenant_memberships membership
       where membership.tenant_id = p_tenant_id
         and membership.user_id = public.current_user_id()
         and membership.status = 'active'
         and membership.canvas_role = 'creator'
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
        or (
          view_row.surface = 'canvas'
          and public.can_create_canvas(p_tenant_id)
          and (
            view_row.owner_user_id = public.current_user_id()
            or public.has_analytics_view_grant(p_tenant_id, p_view_id, 'edit')
          )
        )
      )
  )
$$;

drop policy "analytics views: selected tenant inserts" on public.analytics_views;
create policy "analytics views: selected tenant inserts"
on public.analytics_views for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.can_use_analytics_surface(tenant_id, surface)
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
  and owner_user_id = public.current_user_id()
  and status = 'draft'
  and visibility = 'private'
  and not is_default
  and (
    (surface = 'canvas' and public.can_create_canvas(tenant_id))
    or (surface = 'pulse' and public.is_kpi_governor(tenant_id))
  )
);

revoke execute on function public.can_create_canvas(uuid) from public;
grant execute on function public.can_create_canvas(uuid) to app_user;
