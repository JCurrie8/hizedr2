-- Phase 0 core schema: tenants, identity, organisation hierarchy, audit.
--
-- Modeling notes:
-- * profiles is tenant-agnostic; tenant_memberships is the per-tenant role
--   join. profiles.auth_user_id maps to Better Auth's "user".id (text) so
--   the rest of the schema stays on uuid without caring about Better
--   Auth's id format — see 0001_better_auth.sql for why.
-- * platform_admins is a separate global table (not a role value) since it
--   isn't tenant-scoped.
-- * org hierarchy is temporal by construction: org_nodes is the stable
--   identity, org_node_versions is effective-dated with a materialized
--   ltree path for fast subtree checks.
-- * membership_scopes is many-to-many from day one so cross-functional /
--   dotted-line membership (ORG-005) is free later, not a schema change.

create extension if not exists pgcrypto;
create extension if not exists ltree;
create extension if not exists citext;
create extension if not exists btree_gist;  -- needed for uuid `=` inside the exclude-using-gist constraint below

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active','suspended','offboarding','deleted')),
  timezone text not null default 'UTC',
  financial_calendar_start_month smallint not null default 1,
  branding jsonb not null default '{}'::jsonb,
  feature_flags jsonb not null default '{}'::jsonb,
  data_retention_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text not null unique references "user"(id) on delete cascade,
  full_name text,
  avatar_url text,
  is_hized_staff boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_admins (        -- global, NOT tenant-scoped
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create type public.app_role as enum
  ('company_admin','executive','functional_leader','manager','employee','analyst');

create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null,
  status text not null default 'active' check (status in ('invited','active','suspended','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table public.org_nodes (               -- stable identity
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  node_type text not null check (node_type in
    ('company','function','department','region','site','team','employee')),
  linked_user_id uuid references public.profiles(id),  -- set when node_type='employee' and the person has platform login
  code text,
  created_at timestamptz not null default now()
);

create table public.org_node_versions (       -- effective-dated
  id uuid primary key default gen_random_uuid(),
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade, -- denormalized for RLS
  parent_id uuid references public.org_nodes(id),
  name text not null,
  manager_user_id uuid references public.profiles(id),
  path ltree not null,                        -- materialized ancestor path
  valid_from date not null,
  valid_to date,                              -- null = open-ended / current
  created_at timestamptz not null default now(),
  exclude using gist (
    org_node_id with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date)) with &&
  )
);
create index on public.org_node_versions using gist (path);

create table public.membership_scopes (       -- many-to-many, enables ORG-005 later
  membership_id uuid not null references public.tenant_memberships(id) on delete cascade,
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  is_primary boolean not null default true,
  primary key (membership_id, org_node_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email citext not null,
  role public.app_role not null,
  org_node_id uuid references public.org_nodes(id),
  invited_by uuid references public.profiles(id),
  token_hash text not null,                    -- sha-256 of the invite token; raw token only ever in the emailed/copied link
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days')
);

create table public.audit_log (                -- append-only
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id),  -- null = pure platform-level action
  actor_user_id uuid references public.profiles(id),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);
revoke update, delete on public.audit_log from public;
