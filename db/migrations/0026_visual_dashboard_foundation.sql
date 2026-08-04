-- EPIC-07/12: shared governed visual model for configurable Pulse dashboards
-- and Canvas boards. Layouts are shareable; data is never materialised here.
-- Every render still queries KPI values through the viewer's own RLS context.

alter table public.tenant_memberships
  add constraint tenant_memberships_id_tenant_unique unique (id, tenant_id);

create table public.analytics_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  surface text not null check (surface in ('pulse', 'canvas')),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 1200),
  owner_user_id uuid not null references public.profiles(id) on delete restrict,
  visibility text not null default 'private' check (visibility in ('private', 'restricted', 'tenant')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  is_default boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  check (surface = 'pulse' or not is_default),
  check (not is_default or (status = 'published' and visibility = 'tenant'))
);

create unique index analytics_views_one_default_pulse_idx
  on public.analytics_views (tenant_id)
  where surface = 'pulse' and is_default;
create index analytics_views_tenant_surface_status_idx
  on public.analytics_views (tenant_id, surface, status, updated_at desc);
create index analytics_views_owner_surface_idx
  on public.analytics_views (tenant_id, owner_user_id, surface, updated_at desc);

create table public.analytics_view_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  view_id uuid not null,
  grantee_type text not null check (grantee_type in ('tenant', 'membership', 'role', 'org_node')),
  grantee_membership_id uuid,
  grantee_role public.app_role,
  grantee_org_node_id uuid,
  permission text not null default 'view' check (permission in ('view', 'edit')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (view_id, tenant_id)
    references public.analytics_views(id, tenant_id) on delete cascade,
  foreign key (grantee_membership_id, tenant_id)
    references public.tenant_memberships(id, tenant_id) on delete cascade,
  foreign key (grantee_org_node_id, tenant_id)
    references public.org_nodes(id, tenant_id) on delete cascade,
  check (
    (grantee_type = 'tenant' and grantee_membership_id is null and grantee_role is null and grantee_org_node_id is null)
    or (grantee_type = 'membership' and grantee_membership_id is not null and grantee_role is null and grantee_org_node_id is null)
    or (grantee_type = 'role' and grantee_membership_id is null and grantee_role is not null and grantee_org_node_id is null)
    or (grantee_type = 'org_node' and grantee_membership_id is null and grantee_role is null and grantee_org_node_id is not null)
  )
);

create unique index analytics_view_grants_one_tenant_idx
  on public.analytics_view_grants (tenant_id, view_id, permission)
  where grantee_type = 'tenant';
create unique index analytics_view_grants_membership_idx
  on public.analytics_view_grants (tenant_id, view_id, grantee_membership_id, permission)
  where grantee_type = 'membership';
create unique index analytics_view_grants_role_idx
  on public.analytics_view_grants (tenant_id, view_id, grantee_role, permission)
  where grantee_type = 'role';
create unique index analytics_view_grants_org_node_idx
  on public.analytics_view_grants (tenant_id, view_id, grantee_org_node_id, permission)
  where grantee_type = 'org_node';

create table public.analytics_widgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  view_id uuid not null,
  title text not null check (length(trim(title)) between 1 and 120),
  subtitle text not null default '' check (length(subtitle) <= 500),
  visual_type text not null check (visual_type in (
    'kpi', 'line', 'area', 'bar', 'horizontal_bar', 'stacked_bar',
    'donut', 'gauge', 'funnel', 'heatmap', 'table', 'text',
    'combo', 'waterfall', 'treemap', 'radar', 'scatter', 'bullet'
  )),
  source_mode text not null default 'current' check (source_mode in ('current', 'children', 'trend')),
  position integer not null check (position >= 0),
  width smallint not null default 6 check (width between 3 and 12),
  height text not null default 'standard' check (height in ('compact', 'standard', 'tall')),
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  static_text text not null default '' check (length(static_text) <= 5000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, view_id, position),
  foreign key (view_id, tenant_id)
    references public.analytics_views(id, tenant_id) on delete cascade,
  check ((visual_type = 'text') or static_text = '')
);

create index analytics_widgets_view_position_idx
  on public.analytics_widgets (tenant_id, view_id, position);

create table public.analytics_widget_metrics (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  widget_id uuid not null,
  kpi_definition_id uuid not null,
  position integer not null check (position >= 0),
  series_label text not null default '' check (length(series_label) <= 120),
  primary key (widget_id, kpi_definition_id),
  unique (tenant_id, widget_id, position),
  foreign key (widget_id, tenant_id)
    references public.analytics_widgets(id, tenant_id) on delete cascade,
  foreign key (kpi_definition_id, tenant_id)
    references public.kpi_definitions(id, tenant_id) on delete restrict
);

create index analytics_widget_metrics_kpi_idx
  on public.analytics_widget_metrics (tenant_id, kpi_definition_id, widget_id);

-- A selected-tenant product check shared by view policies. This runs as the
-- migration owner so entitlement lookup is independent of nested RLS.
create or replace function public.can_use_analytics_surface(p_tenant_id uuid, p_surface text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    p_tenant_id = public.current_tenant_id()
    and public.current_user_has_tenant_access(p_tenant_id)
    and p_surface in ('pulse', 'canvas')
    and exists (
      select 1
      from public.tenant_product_entitlements entitlement
      where entitlement.tenant_id = p_tenant_id
        and entitlement.product_key = p_surface
        and entitlement.status in ('active', 'trial')
    )
$$;

create or replace function public.has_analytics_view_grant(
  p_tenant_id uuid,
  p_view_id uuid,
  p_permission text default 'view'
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.analytics_view_grants grant_row
    join public.tenant_memberships membership
      on membership.tenant_id = p_tenant_id
     and membership.user_id = public.current_user_id()
     and membership.status = 'active'
    left join public.org_node_versions granted_node
      on granted_node.tenant_id = grant_row.tenant_id
     and granted_node.org_node_id = grant_row.grantee_org_node_id
     and granted_node.valid_from <= current_date
     and (granted_node.valid_to is null or granted_node.valid_to > current_date)
    where grant_row.tenant_id = p_tenant_id
      and grant_row.view_id = p_view_id
      and (grant_row.permission = p_permission or grant_row.permission = 'edit')
      and (
        grant_row.grantee_type = 'tenant'
        or (grant_row.grantee_type = 'membership' and grant_row.grantee_membership_id = membership.id)
        or (grant_row.grantee_type = 'role' and grant_row.grantee_role = membership.role)
        or (
          grant_row.grantee_type = 'org_node'
          and exists (
            select 1
            from unnest(public.current_user_scope_paths()) as user_scope(path)
            where granted_node.path OPERATOR(public.@>) user_scope.path
          )
        )
      )
  )
$$;

-- Row-shaped helper avoids INSERT ... RETURNING self-query snapshot problems.
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

create or replace function public.can_read_analytics_view_child(p_tenant_id uuid, p_view_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.analytics_views view_row
    where view_row.tenant_id = p_tenant_id
      and view_row.id = p_view_id
      and public.can_read_analytics_view_row(
        view_row.tenant_id, view_row.id, view_row.surface,
        view_row.status, view_row.visibility, view_row.owner_user_id
      )
  )
$$;

create or replace function public.analytics_view_identity_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.surface is distinct from old.surface
     or new.owner_user_id is distinct from old.owner_user_id
     or new.created_by is distinct from old.created_by then
    raise exception 'analytics view tenant, surface, owner and creator are immutable';
  end if;
  return new;
end;
$$;

create trigger analytics_view_identity_before_update
before update on public.analytics_views
for each row execute function public.analytics_view_identity_is_immutable();

create or replace function public.analytics_widget_identity_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.view_id is distinct from old.view_id
     or new.created_by is distinct from old.created_by then
    raise exception 'analytics widget tenant, view and creator are immutable';
  end if;
  return new;
end;
$$;

create trigger analytics_widget_identity_before_update
before update on public.analytics_widgets
for each row execute function public.analytics_widget_identity_is_immutable();

create or replace function public.analytics_widget_metric_parent_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.widget_id is distinct from old.widget_id then
    raise exception 'analytics widget metric tenant and widget are immutable';
  end if;
  return new;
end;
$$;

create trigger analytics_widget_metric_parent_before_update
before update on public.analytics_widget_metrics
for each row execute function public.analytics_widget_metric_parent_is_immutable();

alter table public.analytics_views enable row level security;
alter table public.analytics_view_grants enable row level security;
alter table public.analytics_widgets enable row level security;
alter table public.analytics_widget_metrics enable row level security;

create policy "analytics views: permitted reads"
on public.analytics_views for select
using (public.can_read_analytics_view_row(tenant_id, id, surface, status, visibility, owner_user_id));

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
  and (surface = 'canvas' or public.is_kpi_governor(tenant_id))
);

create policy "analytics views: selected tenant updates"
on public.analytics_views for update
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, id)
  and updated_by = public.current_user_id()
  and (surface = 'canvas' or public.is_kpi_governor(tenant_id))
);

create policy "analytics views: selected tenant deletes"
on public.analytics_views for delete
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, id)
);

create policy "analytics grants: permitted reads"
on public.analytics_view_grants for select
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
);

create policy "analytics grants: selected tenant inserts"
on public.analytics_view_grants for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
  and created_by = public.current_user_id()
);

create policy "analytics grants: selected tenant updates"
on public.analytics_view_grants for update
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
);

create policy "analytics grants: selected tenant deletes"
on public.analytics_view_grants for delete
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
);

create policy "analytics widgets: permitted reads"
on public.analytics_widgets for select
using (public.can_read_analytics_view_child(tenant_id, view_id));

create policy "analytics widgets: selected tenant inserts"
on public.analytics_widgets for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
  and created_by = public.current_user_id()
  and updated_by = public.current_user_id()
);

create policy "analytics widgets: selected tenant updates"
on public.analytics_widgets for update
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
  and updated_by = public.current_user_id()
);

create policy "analytics widgets: selected tenant deletes"
on public.analytics_widgets for delete
using (
  tenant_id = public.current_tenant_id()
  and public.can_edit_analytics_view(tenant_id, view_id)
);

create policy "analytics widget metrics: permitted reads"
on public.analytics_widget_metrics for select
using (
  exists (
    select 1
    from public.analytics_widgets widget
    where widget.tenant_id = analytics_widget_metrics.tenant_id
      and widget.id = analytics_widget_metrics.widget_id
      and public.can_read_analytics_view_child(widget.tenant_id, widget.view_id)
  )
);

create policy "analytics widget metrics: selected tenant inserts"
on public.analytics_widget_metrics for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.can_read_kpi_definition(tenant_id, kpi_definition_id)
  and exists (
    select 1 from public.kpi_definitions definition
    where definition.tenant_id = analytics_widget_metrics.tenant_id
      and definition.id = analytics_widget_metrics.kpi_definition_id
      and definition.approval_status = 'approved'
  )
  and exists (
    select 1
    from public.analytics_widgets widget
    where widget.tenant_id = analytics_widget_metrics.tenant_id
      and widget.id = analytics_widget_metrics.widget_id
      and public.can_edit_analytics_view(widget.tenant_id, widget.view_id)
  )
);

create policy "analytics widget metrics: selected tenant updates"
on public.analytics_widget_metrics for update
using (
  tenant_id = public.current_tenant_id()
  and exists (
    select 1
    from public.analytics_widgets widget
    where widget.tenant_id = analytics_widget_metrics.tenant_id
      and widget.id = analytics_widget_metrics.widget_id
      and public.can_edit_analytics_view(widget.tenant_id, widget.view_id)
  )
)
with check (
  tenant_id = public.current_tenant_id()
  and public.can_read_kpi_definition(tenant_id, kpi_definition_id)
  and exists (
    select 1 from public.kpi_definitions definition
    where definition.tenant_id = analytics_widget_metrics.tenant_id
      and definition.id = analytics_widget_metrics.kpi_definition_id
      and definition.approval_status = 'approved'
  )
);

create policy "analytics widget metrics: selected tenant deletes"
on public.analytics_widget_metrics for delete
using (
  tenant_id = public.current_tenant_id()
  and exists (
    select 1
    from public.analytics_widgets widget
    where widget.tenant_id = analytics_widget_metrics.tenant_id
      and widget.id = analytics_widget_metrics.widget_id
      and public.can_edit_analytics_view(widget.tenant_id, widget.view_id)
  )
);

revoke execute on function public.can_use_analytics_surface(uuid, text) from public;
revoke execute on function public.has_analytics_view_grant(uuid, uuid, text) from public;
revoke execute on function public.can_read_analytics_view_row(uuid, uuid, text, text, text, uuid) from public;
revoke execute on function public.can_edit_analytics_view(uuid, uuid) from public;
revoke execute on function public.can_read_analytics_view_child(uuid, uuid) from public;
revoke execute on function public.analytics_view_identity_is_immutable() from public;
revoke execute on function public.analytics_widget_identity_is_immutable() from public;
revoke execute on function public.analytics_widget_metric_parent_is_immutable() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant select, insert, update, delete on public.analytics_views to app_user';
    execute 'grant select, insert, update, delete on public.analytics_view_grants to app_user';
    execute 'grant select, insert, update, delete on public.analytics_widgets to app_user';
    execute 'grant select, insert, update, delete on public.analytics_widget_metrics to app_user';
    execute 'grant execute on function public.can_use_analytics_surface(uuid, text) to app_user';
    execute 'grant execute on function public.has_analytics_view_grant(uuid, uuid, text) to app_user';
    execute 'grant execute on function public.can_read_analytics_view_row(uuid, uuid, text, text, text, uuid) to app_user';
    execute 'grant execute on function public.can_edit_analytics_view(uuid, uuid) to app_user';
    execute 'grant execute on function public.can_read_analytics_view_child(uuid, uuid) to app_user';
  end if;
end
$$;

-- Canvas remains locked by default for ordinary tenants. The two synthetic
-- demonstration tenants receive a trial so production can exercise the real
-- board journey without changing the commercial default for new customers.
update public.tenant_product_entitlements entitlement
set status = 'trial', changed_at = now()
from public.tenants tenant
where tenant.id = entitlement.tenant_id
  and entitlement.product_key = 'canvas'
  and tenant.slug in ('northstar-installations', 'harbour-field-services');
