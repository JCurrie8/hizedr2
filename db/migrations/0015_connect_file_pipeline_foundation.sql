-- EPIC-04/05 foundation: tenant-scoped connectors, immutable source batches,
-- observable pipeline runs, validations, landed rows and a minimal curated
-- upsert target. Files, SharePoint revisions and CRM extracts share the same
-- batch/run/checkpoint contract.

create or replace function public.is_connect_operator(p_tenant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships m
    where m.user_id = public.current_user_id()
      and m.tenant_id = p_tenant_id
      and m.status = 'active'
      and m.role in ('company_admin', 'analyst')
  )
$$;

revoke execute on function public.is_connect_operator(uuid) from public;

create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_type text not null check (connector_type in
    ('file_upload', 'sharepoint', 'sql_server', 'azure_sql', 'salesforce',
     'zendesk', 'hubspot', 'dynamics365', 'rest_api')),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled', 'error')),
  auth_mode text not null default 'none' check (auth_mode in
    ('none', 'oauth2', 'client_credentials', 'jwt_bearer', 'api_token', 'connection_string')),
  adapter_version integer not null default 1 check (adapter_version > 0),
  config jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles(id),
  last_tested_at timestamptz,
  last_test_status text check (last_test_status is null or last_test_status in ('succeeded', 'failed')),
  last_test_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (id, tenant_id, connector_type),
  unique (tenant_id, name)
);
create index connectors_tenant_status_idx on public.connectors (tenant_id, status);

-- OAuth refresh tokens / client secrets are encrypted in application code
-- before they reach Postgres. The key itself lives only in the deployment
-- secret store; none of these columns may be returned by a UI query.
create table public.connector_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_id uuid not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  key_version integer not null default 1 check (key_version > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (id, tenant_id),
  unique (connector_id),
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete cascade
);
create index connector_credentials_tenant_idx on public.connector_credentials (tenant_id);

-- Graph delta links are opaque reconciliation cursors. Webhooks are only a
-- prompt to run delta again; they are never treated as a complete event log.
create table public.connector_sync_state (
  connector_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  delta_link text,
  webhook_subscription_id text,
  webhook_expires_at timestamptz,
  last_polled_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_retry_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (connector_id, tenant_id),
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete cascade
);
create index connector_sync_state_due_idx
  on public.connector_sync_state (next_retry_at)
  where next_retry_at is not null;

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_id uuid not null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'disabled')),
  source_config jsonb not null default '{}'::jsonb,
  load_mode text not null default 'snapshot' check (load_mode in ('snapshot', 'append', 'upsert')),
  key_columns text[] not null default array[]::text[],
  schedule_cron text,
  schedule_timezone text not null default 'UTC',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (id, tenant_id, connector_id),
  unique (tenant_id, name),
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete restrict,
  check (load_mode <> 'upsert' or cardinality(key_columns) > 0)
);
create index pipelines_tenant_status_idx on public.pipelines (tenant_id, status);
create index pipelines_connector_idx on public.pipelines (connector_id);

-- Checkpoints are committed only after a complete successful run. An overlap
-- window intentionally rereads recent records (for example Salesforce's
-- previous 24 hours); curated upserts make that replay idempotent.
create table public.pipeline_checkpoints (
  pipeline_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  strategy text not null check (strategy in
    ('full_refresh', 'modified_since', 'cursor', 'delta')),
  cursor_value jsonb not null default '{}'::jsonb,
  overlap_seconds integer not null default 0 check (overlap_seconds >= 0),
  committed_through_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (pipeline_id, tenant_id),
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade
);
create index pipeline_checkpoints_tenant_idx on public.pipeline_checkpoints (tenant_id);

-- A batch is one immutable source observation: a Graph driveItem revision,
-- manual upload, Salesforce object extraction window, Zendesk cursor page
-- set, or another adapter's equivalent. Extracted content is staged in object
-- storage and hashed before processing.
create table public.source_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_id uuid not null,
  batch_kind text not null check (batch_kind in ('file_revision', 'api_extract')),
  source_item_id text not null,
  source_path text,
  source_name text not null,
  source_etag text,
  source_ctag text,
  source_modified_at timestamptz,
  window_started_at timestamptz,
  window_ended_at timestamptz,
  cursor_start jsonb,
  cursor_end jsonb,
  discovered_at timestamptz not null default now(),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (id, tenant_id),
  unique (id, tenant_id, connector_id),
  unique (connector_id, source_item_id, content_sha256),
  foreign key (connector_id, tenant_id)
    references public.connectors(id, tenant_id) on delete cascade,
  check (window_ended_at is null or window_started_at is not null),
  check (window_ended_at is null or window_ended_at >= window_started_at)
);
create index source_batches_tenant_discovered_idx
  on public.source_batches (tenant_id, discovered_at desc);
create index source_batches_connector_item_idx
  on public.source_batches (connector_id, source_item_id, source_modified_at desc);

create table public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  connector_id uuid not null,
  source_batch_id uuid not null,
  trigger_type text not null check (trigger_type in
    ('manual_upload', 'manual_sync', 'schedule', 'webhook', 'retry', 'backfill')),
  status text not null default 'queued' check (status in
    ('queued', 'running', 'succeeded', 'warning', 'failed', 'cancelled')),
  initiated_by uuid references public.profiles(id),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  rows_received integer not null default 0 check (rows_received >= 0),
  rows_accepted integer not null default 0 check (rows_accepted >= 0),
  rows_rejected integer not null default 0 check (rows_rejected >= 0),
  error_code text,
  error_message text,
  source_watermark text,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (pipeline_id, source_batch_id),
  foreign key (pipeline_id, tenant_id, connector_id)
    references public.pipelines(id, tenant_id, connector_id) on delete cascade,
  foreign key (source_batch_id, tenant_id, connector_id)
    references public.source_batches(id, tenant_id, connector_id) on delete restrict,
  check (rows_accepted + rows_rejected <= rows_received),
  check (finished_at is null or started_at is not null),
  check (finished_at is null or finished_at >= started_at)
);
create index pipeline_runs_pipeline_queued_idx on public.pipeline_runs (pipeline_id, queued_at desc);
create index pipeline_runs_tenant_status_idx on public.pipeline_runs (tenant_id, status, queued_at desc);

create table public.pipeline_run_steps (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null,
  step_key text not null,
  attempt integer not null default 1 check (attempt > 0),
  status text not null check (status in ('queued', 'running', 'succeeded', 'warning', 'failed', 'skipped')),
  started_at timestamptz,
  finished_at timestamptz,
  rows_in integer check (rows_in is null or rows_in >= 0),
  rows_out integer check (rows_out is null or rows_out >= 0),
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (run_id, step_key, attempt),
  foreign key (run_id, tenant_id)
    references public.pipeline_runs(id, tenant_id) on delete cascade,
  check (finished_at is null or started_at is not null),
  check (finished_at is null or finished_at >= started_at)
);
create index pipeline_run_steps_run_idx on public.pipeline_run_steps (run_id, id);

create table public.validation_results (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null,
  rule_key text not null,
  rule_type text not null check (rule_type in
    ('required', 'unique', 'type', 'range', 'accepted_values', 'row_count', 'schema_drift', 'custom')),
  severity text not null check (severity in ('warning', 'error')),
  status text not null check (status in ('passed', 'failed')),
  affected_rows integer not null default 0 check (affected_rows >= 0),
  message text not null,
  sample jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (run_id, rule_key),
  foreign key (run_id, tenant_id)
    references public.pipeline_runs(id, tenant_id) on delete cascade
);
create index validation_results_run_status_idx on public.validation_results (run_id, status, severity);

create table public.landed_rows (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null,
  row_number integer not null check (row_number > 0),
  disposition text not null default 'accepted' check (disposition in ('accepted', 'quarantined')),
  record_key text,
  data jsonb not null,
  rejection_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (run_id, row_number),
  foreign key (run_id, tenant_id)
    references public.pipeline_runs(id, tenant_id) on delete cascade
);
create index landed_rows_run_disposition_idx on public.landed_rows (run_id, disposition, row_number);

-- The first curated target is deliberately generic. EPIC-06 will layer
-- governed dataset metadata and role/org-scope policies over it; until then
-- only Connect operators can read it.
create table public.curated_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  record_key text not null,
  data jsonb not null,
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  source_run_id uuid not null,
  source_row_number integer not null check (source_row_number > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (pipeline_id, record_key),
  foreign key (pipeline_id, tenant_id)
    references public.pipelines(id, tenant_id) on delete cascade,
  foreign key (source_run_id, tenant_id)
    references public.pipeline_runs(id, tenant_id) on delete restrict,
  check ((not is_deleted and deleted_at is null) or (is_deleted and deleted_at is not null)),
  check (last_seen_at >= first_seen_at)
);
create index curated_records_tenant_pipeline_idx on public.curated_records (tenant_id, pipeline_id);

-- A single complete predicate is intentionally used for every command.
-- Do not add a broader SELECT policy next to it: Postgres policies are
-- permissive by default and would OR the predicates, recreating the leak
-- shape documented for migrations 0006 and 0011.
alter table public.connectors enable row level security;
alter table public.connector_credentials enable row level security;
alter table public.connector_sync_state enable row level security;
alter table public.pipelines enable row level security;
alter table public.pipeline_checkpoints enable row level security;
alter table public.source_batches enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.pipeline_run_steps enable row level security;
alter table public.validation_results enable row level security;
alter table public.landed_rows enable row level security;
alter table public.curated_records enable row level security;

create policy "connectors: scoped operator access" on public.connectors for all
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

create policy "connector credentials: scoped operator access" on public.connector_credentials for all
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

create policy "connector sync: scoped operator access" on public.connector_sync_state for all
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

create policy "pipelines: scoped operator access" on public.pipelines for all
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

create policy "pipeline checkpoints: scoped operator access" on public.pipeline_checkpoints for all
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

create policy "source batches: scoped operator access" on public.source_batches for all
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

create policy "pipeline runs: scoped operator access" on public.pipeline_runs for all
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

create policy "pipeline steps: scoped operator access" on public.pipeline_run_steps for all
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

create policy "validation results: scoped operator access" on public.validation_results for all
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

create policy "landed rows: scoped operator access" on public.landed_rows for all
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

create policy "curated records: scoped operator access" on public.curated_records for all
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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    execute 'grant execute on function public.is_connect_operator(uuid) to app_user';
  end if;
end
$$;
