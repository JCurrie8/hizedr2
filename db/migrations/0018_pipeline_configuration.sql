-- Analyst-configurable pipeline mappings and immutable configuration history.
-- Connections retain credentials and source discovery; pipelines own the
-- repeatable shaping/load contract that writes Hized-managed SQL records.

create table public.pipeline_field_mappings (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  source_field public.citext not null,
  target_field public.citext not null,
  data_type text not null default 'string' check (data_type in
    ('string', 'integer', 'numeric', 'boolean', 'date', 'timestamp')),
  is_included boolean not null default true,
  is_required boolean not null default false,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (pipeline_id, source_field),
  unique (pipeline_id, target_field),
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade,
  check (length(btrim(source_field::text)) between 1 and 200),
  check (length(btrim(target_field::text)) between 1 and 200),
  check (not is_required or is_included)
);
create index pipeline_field_mappings_tenant_pipeline_idx
  on public.pipeline_field_mappings (tenant_id, pipeline_id, position);

create table public.pipeline_config_versions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  version_number integer not null check (version_number > 0),
  configuration jsonb not null,
  change_note text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (pipeline_id, version_number),
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade,
  check (jsonb_typeof(configuration) = 'object'),
  check (change_note is null or length(change_note) <= 500)
);
create index pipeline_config_versions_tenant_pipeline_idx
  on public.pipeline_config_versions (tenant_id, pipeline_id, version_number desc);

alter table public.pipeline_field_mappings enable row level security;
alter table public.pipeline_config_versions enable row level security;

-- Keep one complete predicate per table. Adding a broader permissive policy
-- would OR with this one and can recreate the cross-tenant leak shape fixed
-- in migrations 0006 and 0011.
create policy "pipeline mappings: scoped operator access" on public.pipeline_field_mappings for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);

create policy "pipeline versions: scoped operator access" on public.pipeline_config_versions for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and (public.is_connect_operator(tenant_id) or public.is_platform_admin())
);

-- History is append-only to the restricted runtime role. The table owner is
-- reserved for migrations/operations and is never used by the application.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'revoke update, delete on public.pipeline_config_versions from app_user';
  end if;
end
$$;
