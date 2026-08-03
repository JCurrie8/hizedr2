import type { PoolClient } from "@neondatabase/serverless";
import {
  openMicrosoftCredentials,
  sealMicrosoftCredentials,
  type MicrosoftCredentials,
  type SealedValue,
} from "./microsoft-oauth";
import type { ResolvedMicrosoftWorkbook } from "./microsoft-graph";
import type { LoadMode } from "./tabular-load";

export interface MicrosoftConnectorOverview {
  id: string;
  name: string;
  status: string;
  connectedEmail: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  sourceName: string | null;
  sourcePath: string | null;
  loadMode: LoadMode | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface SharePointSyncContext {
  connectorId: string;
  pipeline: {
    id: string;
    connectorId: string;
    name: string;
    loadMode: LoadMode;
    keyColumns: string[];
  };
  source: ResolvedMicrosoftWorkbook;
  deltaLink: string | null;
  credentials: MicrosoftCredentials;
}

function sealedFromRow(row: Record<string, unknown>): SealedValue {
  return {
    ciphertext: Buffer.from(row.ciphertext as Uint8Array),
    iv: Buffer.from(row.iv as Uint8Array),
    authTag: Buffer.from(row.auth_tag as Uint8Array),
    keyVersion: Number(row.key_version),
  };
}

export async function createMicrosoftConnector(
  client: PoolClient,
  input: {
    tenantId: string;
    createdBy: string;
    name: string;
    account: { id: string; displayName: string | null; email: string | null };
    credentials: MicrosoftCredentials;
  },
): Promise<{ connectorId: string }> {
  const { rows: [connector] } = await client.query(
    `insert into public.connectors
       (tenant_id, connector_type, name, status, auth_mode, config, created_by, last_tested_at, last_test_status, last_test_message)
     values ($1, 'sharepoint', $2, 'draft', 'oauth2', $3::jsonb, $4, now(), 'succeeded', 'Microsoft account connected')
     returning id`,
    [input.tenantId, input.name, JSON.stringify({ connectedAccount: input.account }), input.createdBy],
  );
  const sealed = sealMicrosoftCredentials(input.credentials, { tenantId: input.tenantId, connectorId: connector.id });
  await client.query(
    `insert into public.connector_credentials
       (tenant_id, connector_id, ciphertext, iv, auth_tag, key_version, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [input.tenantId, connector.id, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, input.createdBy],
  );
  await client.query(
    `insert into public.connector_sync_state (connector_id, tenant_id)
     values ($1, $2)`,
    [connector.id, input.tenantId],
  );
  return { connectorId: connector.id };
}

export async function listMicrosoftConnectors(
  client: PoolClient,
  input: { tenantId: string },
): Promise<MicrosoftConnectorOverview[]> {
  const { rows } = await client.query(
    `select c.id, c.name, c.status, c.config #>> '{connectedAccount,email}' as connected_email,
            p.id as pipeline_id, p.name as pipeline_name, p.load_mode,
            p.source_config ->> 'sourceName' as source_name,
            p.source_config ->> 'sourcePath' as source_path,
            css.last_success_at, css.last_error
     from public.connectors c
     left join public.pipelines p
       on p.connector_id = c.id and p.tenant_id = c.tenant_id and p.status <> 'disabled'
     left join public.connector_sync_state css
       on css.connector_id = c.id and css.tenant_id = c.tenant_id
     where c.tenant_id = $1 and c.connector_type = 'sharepoint' and c.status <> 'disabled'
     order by c.created_at desc`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    connectedEmail: row.connected_email,
    pipelineId: row.pipeline_id ?? null,
    pipelineName: row.pipeline_name ?? null,
    sourceName: row.source_name ?? null,
    sourcePath: row.source_path ?? null,
    loadMode: row.load_mode ?? null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    lastError: row.last_error ?? null,
  }));
}

export async function getMicrosoftConnectorCredentials(
  client: PoolClient,
  input: { tenantId: string; connectorId: string },
): Promise<MicrosoftCredentials> {
  const { rows: [row] } = await client.query(
    `select cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version
     from public.connector_credentials cc
     join public.connectors c on c.id = cc.connector_id and c.tenant_id = cc.tenant_id
     where cc.tenant_id = $1 and cc.connector_id = $2
       and c.connector_type = 'sharepoint' and c.status in ('draft', 'active', 'error')`,
    [input.tenantId, input.connectorId],
  );
  if (!row) throw new Error("The Microsoft connector was not found or has no credentials.");
  return openMicrosoftCredentials(sealedFromRow(row), input);
}

export async function replaceMicrosoftConnectorCredentials(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; credentials: MicrosoftCredentials },
): Promise<void> {
  const sealed = sealMicrosoftCredentials(input.credentials, input);
  const result = await client.query(
    `update public.connector_credentials set
       ciphertext = $3, iv = $4, auth_tag = $5, key_version = $6, rotated_at = now()
     where tenant_id = $1 and connector_id = $2`,
    [input.tenantId, input.connectorId, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
  );
  if (result.rowCount !== 1) throw new Error("The Microsoft connector credentials could not be updated.");
}

export async function configureMicrosoftWorkbookPipeline(
  client: PoolClient,
  input: {
    tenantId: string;
    connectorId: string;
    createdBy: string;
    pipelineName: string;
    loadMode: LoadMode;
    keyColumns: string[];
    source: ResolvedMicrosoftWorkbook;
  },
): Promise<{ pipelineId: string }> {
  const { rows: [connector] } = await client.query(
    `select id, config from public.connectors
     where id = $1 and tenant_id = $2 and connector_type = 'sharepoint' and status in ('draft', 'active', 'error')
     for update`,
    [input.connectorId, input.tenantId],
  );
  if (!connector) throw new Error("The Microsoft connector was not found.");
  const { rows: [existing] } = await client.query(
    `select id from public.pipelines where connector_id = $1 and tenant_id = $2 and status <> 'disabled' limit 1`,
    [input.connectorId, input.tenantId],
  );
  if (existing) throw new Error("This Microsoft connection already has a monitored workbook.");
  const sourceConfig = {
    sourceKind: input.source.sourceKind,
    siteId: input.source.siteId,
    driveId: input.source.driveId,
    driveItemId: input.source.driveItemId,
    sourceName: input.source.sourceName,
    sourcePath: input.source.sourcePath,
    acceptedExtensions: ["csv", "xlsx"],
    headerRow: 1,
  };
  const { rows: [pipeline] } = await client.query(
    `insert into public.pipelines
       (tenant_id, connector_id, name, status, source_config, load_mode, key_columns, created_by)
     values ($1, $2, $3, 'active', $4::jsonb, $5, $6::text[], $7)
     returning id`,
    [input.tenantId, input.connectorId, input.pipelineName, JSON.stringify(sourceConfig), input.loadMode, input.keyColumns, input.createdBy],
  );
  await client.query(
    `insert into public.pipeline_checkpoints (pipeline_id, tenant_id, strategy)
     values ($1, $2, 'delta')`,
    [pipeline.id, input.tenantId],
  );
  await client.query(
    `update public.connectors set
       status = 'active', config = config || $3::jsonb, updated_at = now(),
       last_tested_at = now(), last_test_status = 'succeeded', last_test_message = 'Workbook resolved through Microsoft Graph'
     where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId, JSON.stringify({ selectedSource: sourceConfig })],
  );
  return { pipelineId: pipeline.id };
}

export async function getSharePointSyncContext(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<SharePointSyncContext> {
  const { rows: [row] } = await client.query(
    `select c.id as connector_id, p.id as pipeline_id, p.name as pipeline_name,
            p.load_mode, p.key_columns, p.source_config, css.delta_link,
            cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version
     from public.pipelines p
     join public.connectors c
       on c.id = p.connector_id and c.tenant_id = p.tenant_id
     join public.connector_credentials cc
       on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
     join public.connector_sync_state css
       on css.connector_id = c.id and css.tenant_id = c.tenant_id
     where p.id = $1 and p.tenant_id = $2 and p.status = 'active'
       and c.connector_type = 'sharepoint' and c.status in ('active', 'error')`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("The SharePoint workbook pipeline was not found or is not active.");
  const source = row.source_config as Record<string, unknown>;
  if (!source.driveId || !source.driveItemId || !source.sourceName || !source.sourcePath) {
    throw new Error("The SharePoint workbook configuration is incomplete.");
  }
  return {
    connectorId: row.connector_id,
    pipeline: {
      id: row.pipeline_id,
      connectorId: row.connector_id,
      name: row.pipeline_name,
      loadMode: row.load_mode,
      keyColumns: row.key_columns,
    },
    source: {
      sourceKind: source.sourceKind === "sharepoint" ? "sharepoint" : "onedrive",
      siteId: typeof source.siteId === "string" ? source.siteId : null,
      driveId: String(source.driveId),
      driveItemId: String(source.driveItemId),
      sourceName: String(source.sourceName),
      sourcePath: String(source.sourcePath),
      sourceETag: null,
      sourceCTag: null,
      sourceModifiedAt: null,
      sizeBytes: null,
    },
    deltaLink: row.delta_link ?? null,
    credentials: openMicrosoftCredentials(sealedFromRow(row), { tenantId: input.tenantId, connectorId: row.connector_id }),
  };
}

export async function acquireSharePointSyncLease(
  client: PoolClient,
  input: { tenantId: string; connectorId: string },
): Promise<string> {
  const { rows: [row] } = await client.query(
    `update public.connector_sync_state set
       lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes', updated_at = now()
     where connector_id = $1 and tenant_id = $2
       and (lease_expires_at is null or lease_expires_at <= now())
     returning lease_token`,
    [input.connectorId, input.tenantId],
  );
  if (!row) throw new Error("This Microsoft workbook is already synchronizing.");
  return row.lease_token;
}

export async function commitSharePointSyncSuccess(
  client: PoolClient,
  input: {
    tenantId: string;
    connectorId: string;
    pipelineId: string;
    deltaLink: string;
    expectedDeltaLink: string | null;
    leaseToken: string;
  },
): Promise<void> {
  const syncState = await client.query(
    `update public.connector_sync_state set
       delta_link = $3, last_polled_at = now(), last_success_at = now(), last_error = null,
       consecutive_failures = 0, next_retry_at = null,
       next_poll_at = now() + make_interval(mins => poll_interval_minutes),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where connector_id = $1 and tenant_id = $2
       and delta_link is not distinct from $4 and lease_token = $5
     returning connector_id`,
    [input.connectorId, input.tenantId, input.deltaLink, input.expectedDeltaLink, input.leaseToken],
  );
  if (syncState.rowCount !== 1) throw new Error("The Microsoft sync checkpoint changed while this run was active.");
  const checkpoint = await client.query(
    `update public.pipeline_checkpoints set
       cursor_value = jsonb_build_object('deltaLink', $3::text), committed_through_at = now(), updated_at = now()
     where pipeline_id = $1 and tenant_id = $2 and strategy = 'delta'`,
    [input.pipelineId, input.tenantId, input.deltaLink],
  );
  if (checkpoint.rowCount !== 1) throw new Error("The Microsoft pipeline delta checkpoint was not found.");
  await client.query(
    `update public.connectors set status = 'active', updated_at = now(),
       last_tested_at = now(), last_test_status = 'succeeded', last_test_message = 'Microsoft Graph synchronization succeeded'
     where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId],
  );
}

export async function commitSharePointSelectedItemDeleted(
  client: PoolClient,
  input: {
    tenantId: string;
    connectorId: string;
    pipelineId: string;
    deltaLink: string;
    expectedDeltaLink: string | null;
    leaseToken: string;
  },
): Promise<void> {
  const message = "The selected Microsoft workbook was deleted or moved outside the connected drive.";
  const syncState = await client.query(
    `update public.connector_sync_state set
       delta_link = $3, last_polled_at = now(), last_error = $4,
       consecutive_failures = 0, next_retry_at = null,
       next_poll_at = now() + make_interval(mins => poll_interval_minutes),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where connector_id = $1 and tenant_id = $2
       and delta_link is not distinct from $5 and lease_token = $6
     returning connector_id`,
    [input.connectorId, input.tenantId, input.deltaLink, message, input.expectedDeltaLink, input.leaseToken],
  );
  if (syncState.rowCount !== 1) throw new Error("The Microsoft sync checkpoint changed while this run was active.");
  const checkpoint = await client.query(
    `update public.pipeline_checkpoints set
       cursor_value = jsonb_build_object('deltaLink', $3::text), committed_through_at = now(), updated_at = now()
     where pipeline_id = $1 and tenant_id = $2 and strategy = 'delta'`,
    [input.pipelineId, input.tenantId, input.deltaLink],
  );
  if (checkpoint.rowCount !== 1) throw new Error("The Microsoft pipeline delta checkpoint was not found.");
  await client.query(
    `update public.connectors set status = 'error', updated_at = now(), last_test_status = 'failed', last_test_message = $3
     where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId, message],
  );
}

export async function recordSharePointSyncFailure(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; message: string; leaseToken: string },
): Promise<boolean> {
  const syncState = await client.query(
    `update public.connector_sync_state set
       last_polled_at = now(), last_error = $3,
       consecutive_failures = consecutive_failures + 1,
       next_retry_at = now() + make_interval(secs => least(3600, 60 * power(2, least(consecutive_failures, 5))::integer)),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where connector_id = $1 and tenant_id = $2 and lease_token = $4
     returning connector_id`,
    [input.connectorId, input.tenantId, input.message.slice(0, 500), input.leaseToken],
  );
  if (syncState.rowCount !== 1) return false;
  await client.query(
    `update public.connectors set status = 'error', updated_at = now(), last_test_status = 'failed', last_test_message = $3
     where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId, input.message.slice(0, 500)],
  );
  return true;
}
