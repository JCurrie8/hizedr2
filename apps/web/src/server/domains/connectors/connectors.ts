import type { PoolClient } from "@neondatabase/serverless";
import type { ParsedTable } from "./tabular-file";
import { listPipelineFieldMappings } from "./pipeline-configuration";
import { prepareTabularLoad, type LoadMode, type PipelineFieldMapping } from "./tabular-load";

export interface ConnectorOverview {
  id: string;
  name: string;
  connectorType: string;
  status: string;
  pipelineCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export interface ManualFilePipeline {
  id: string;
  connectorId: string;
  name: string;
  loadMode: LoadMode;
  keyColumns: string[];
  fieldMappings: PipelineFieldMapping[];
}

export interface PipelineRunOverview {
  id: string;
  pipelineName: string;
  status: string;
  rowsReceived: number;
  rowsAccepted: number;
  rowsRejected: number;
  queuedAt: string;
}

export async function listConnectorOverview(
  client: PoolClient,
  input: { tenantId: string },
): Promise<ConnectorOverview[]> {
  const { rows } = await client.query(
    `select c.id, c.name, c.connector_type, c.status,
            coalesce(pipeline_summary.pipeline_count, 0)::integer as pipeline_count,
            latest_run.status as last_run_status,
            latest_run.queued_at as last_run_at
     from public.connectors c
     left join lateral (
       select count(*) as pipeline_count
       from public.pipelines p
       where p.connector_id = c.id and p.tenant_id = c.tenant_id
     ) pipeline_summary on true
     left join lateral (
       select pr.status, pr.queued_at
       from public.pipeline_runs pr
       where pr.connector_id = c.id and pr.tenant_id = c.tenant_id
       order by pr.queued_at desc
       limit 1
     ) latest_run on true
     where c.tenant_id = $1
     order by c.created_at desc`,
    [input.tenantId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    connectorType: row.connector_type,
    status: row.status,
    pipelineCount: row.pipeline_count,
    lastRunStatus: row.last_run_status,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
  }));
}

export async function createManualFilePipeline(
  client: PoolClient,
  input: {
    tenantId: string;
    createdBy: string;
    name: string;
    loadMode: "snapshot" | "append" | "upsert";
    keyColumns: string[];
  },
): Promise<{ connectorId: string; pipelineId: string }> {
  const { rows: [connector] } = await client.query(
    `insert into public.connectors
       (tenant_id, connector_type, name, status, auth_mode, config, created_by)
     values ($1, 'file_upload', $2, 'active', 'none', $3::jsonb, $4)
     returning id`,
    [input.tenantId, input.name, JSON.stringify({ acceptedExtensions: ["csv", "xlsx"] }), input.createdBy],
  );
  const { rows: [pipeline] } = await client.query(
    `insert into public.pipelines
       (tenant_id, connector_id, name, status, source_config, load_mode, key_columns, created_by)
     values ($1, $2, $3, 'active', $4::jsonb, $5, $6::text[], $7)
     returning id`,
    [
      input.tenantId,
      connector.id,
      input.name,
      JSON.stringify({ acceptedExtensions: ["csv", "xlsx"], headerRow: 1 }),
      input.loadMode,
      input.keyColumns,
      input.createdBy,
    ],
  );
  await client.query(
    `insert into public.pipeline_checkpoints (pipeline_id, tenant_id, strategy)
     values ($1, $2, 'full_refresh')`,
    [pipeline.id, input.tenantId],
  );
  return { connectorId: connector.id, pipelineId: pipeline.id };
}

export async function listManualFilePipelines(
  client: PoolClient,
  input: { tenantId: string },
): Promise<ManualFilePipeline[]> {
  const { rows } = await client.query(
    `select p.id, p.connector_id, p.name, p.load_mode, p.key_columns
     from public.pipelines p
     join public.connectors c
       on c.id = p.connector_id and c.tenant_id = p.tenant_id
     where p.tenant_id = $1
       and p.status = 'active'
       and c.status = 'active'
       and c.connector_type = 'file_upload'
     order by p.name`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    connectorId: row.connector_id,
    name: row.name,
    loadMode: row.load_mode,
    keyColumns: row.key_columns,
    fieldMappings: [],
  }));
}

export async function getManualFilePipeline(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<ManualFilePipeline> {
  const { rows: [row] } = await client.query(
    `select p.id, p.connector_id, p.name, p.load_mode, p.key_columns
     from public.pipelines p
     join public.connectors c
       on c.id = p.connector_id and c.tenant_id = p.tenant_id
     where p.id = $1
       and p.tenant_id = $2
       and p.status = 'active'
       and c.status = 'active'
       and c.connector_type = 'file_upload'`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("The manual file pipeline was not found or is not active.");
  const fieldMappings = await listPipelineFieldMappings(client, input);
  return {
    id: row.id,
    connectorId: row.connector_id,
    name: row.name,
    loadMode: row.load_mode,
    keyColumns: row.key_columns,
    fieldMappings,
  };
}

export async function listRecentPipelineRuns(
  client: PoolClient,
  input: { tenantId: string; limit?: number },
): Promise<PipelineRunOverview[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const { rows } = await client.query(
    `select pr.id, p.name as pipeline_name, pr.status,
            pr.rows_received, pr.rows_accepted, pr.rows_rejected, pr.queued_at
     from public.pipeline_runs pr
     join public.pipelines p on p.id = pr.pipeline_id and p.tenant_id = pr.tenant_id
     where pr.tenant_id = $1
     order by pr.queued_at desc
     limit $2`,
    [input.tenantId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    pipelineName: row.pipeline_name,
    status: row.status,
    rowsReceived: row.rows_received,
    rowsAccepted: row.rows_accepted,
    rowsRejected: row.rows_rejected,
    queuedAt: new Date(row.queued_at).toISOString(),
  }));
}

export interface TabularFileSourceInput {
  tenantId: string;
  pipeline: ManualFilePipeline;
  fileName: string;
  contentType: string;
  contentSha256: string;
  sizeBytes: number;
  storageKey: string;
  sourceModifiedAt: string | null;
  sourceItemId?: string;
  sourcePath?: string | null;
  sourceETag?: string | null;
  sourceCTag?: string | null;
  triggerType?: "manual_upload" | "manual_sync" | "schedule" | "webhook" | "retry" | "backfill";
  sourceMetadata?: Record<string, unknown>;
}

async function resolveManualFileBatch(
  client: PoolClient,
  input: TabularFileSourceInput & { metadata: Record<string, unknown> },
): Promise<{ id: string; reused: boolean }> {
  const { rows: insertedBatches } = await client.query(
    `insert into public.source_batches
       (tenant_id, connector_id, batch_kind, source_item_id, source_path, source_name,
        source_etag, source_ctag, source_modified_at, content_sha256, content_type, size_bytes, storage_key, metadata)
     values ($1, $2, 'file_revision', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     on conflict (connector_id, source_item_id, content_sha256) do nothing
     returning id`,
    [
      input.tenantId,
      input.pipeline.connectorId,
      input.sourceItemId ?? input.fileName,
      input.sourcePath ?? null,
      input.fileName,
      input.sourceETag ?? null,
      input.sourceCTag ?? null,
      input.sourceModifiedAt,
      input.contentSha256,
      input.contentType,
      input.sizeBytes,
      input.storageKey,
      JSON.stringify(input.metadata),
    ],
  );
  if (insertedBatches[0]?.id) return { id: insertedBatches[0].id, reused: false };

  const { rows: [existingBatch] } = await client.query(
    `select id from public.source_batches
     where connector_id = $1 and source_item_id = $2 and content_sha256 = $3`,
    [input.pipeline.connectorId, input.sourceItemId ?? input.fileName, input.contentSha256],
  );
  if (!existingBatch) throw new Error("The source batch could not be resolved after deduplication.");
  return { id: existingBatch.id, reused: true };
}

async function lockPipelineBatch(client: PoolClient, pipelineId: string, sourceBatchId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${pipelineId}:${sourceBatchId}`]);
}

async function findCompletedRun(client: PoolClient, pipelineId: string, sourceBatchId: string) {
  const { rows: [run] } = await client.query(
    `select id, status, rows_accepted, rows_rejected
     from public.pipeline_runs
     where pipeline_id = $1 and source_batch_id = $2 and status in ('succeeded', 'warning')
     order by queued_at desc
     limit 1`,
    [pipelineId, sourceBatchId],
  );
  return run;
}

export async function persistManualFileRun(
  client: PoolClient,
  input: TabularFileSourceInput & {
    actorUserId: string;
    table: ParsedTable;
  },
): Promise<{ runId: string; status: "succeeded" | "warning"; duplicate: boolean; sourceObjectReused: boolean; acceptedRows: number; rejectedRows: number }> {
  const sourceBatch = await resolveManualFileBatch(client, {
    ...input,
    metadata: { ...input.sourceMetadata, sheetName: input.table.sheetName, headers: input.table.headers },
  });
  await lockPipelineBatch(client, input.pipeline.id, sourceBatch.id);
  const existingRun = await findCompletedRun(client, input.pipeline.id, sourceBatch.id);
  if (existingRun) {
    return {
      runId: existingRun.id,
      status: existingRun.status,
      duplicate: true,
      sourceObjectReused: sourceBatch.reused,
      acceptedRows: existingRun.rows_accepted,
      rejectedRows: existingRun.rows_rejected,
    };
  }

  const prepared = prepareTabularLoad({
    table: input.table,
    loadMode: input.pipeline.loadMode,
    keyColumns: input.pipeline.keyColumns,
    contentSha256: input.contentSha256,
    fieldMappings: input.pipeline.fieldMappings,
  });
  const status = prepared.rejectedRows > 0 ? "warning" : "succeeded";
  const { rows: [run] } = await client.query(
    `insert into public.pipeline_runs
       (tenant_id, pipeline_id, connector_id, source_batch_id, trigger_type,
        status, initiated_by, started_at, source_watermark)
     values ($1, $2, $3, $4, $5, 'running', $6, now(), $7)
     returning id`,
    [
      input.tenantId,
      input.pipeline.id,
      input.pipeline.connectorId,
      sourceBatch.id,
      input.triggerType ?? "manual_upload",
      input.actorUserId,
      input.contentSha256,
    ],
  );

  await client.query(
    `insert into public.pipeline_run_steps
       (tenant_id, run_id, step_key, status, started_at, finished_at, rows_in, rows_out, message)
     values ($1, $2, 'parse', 'succeeded', now(), now(), $3, $3, $4)`,
    [input.tenantId, run.id, input.table.rows.length, `Parsed ${input.table.sourceName}`],
  );

  if (prepared.landedRows.length > 0) {
    await client.query(
      `insert into public.landed_rows
         (tenant_id, run_id, row_number, disposition, record_key, data, rejection_reasons)
       select $1, $2, item.row_number, item.disposition, item.record_key, item.data, item.rejection_reasons
       from jsonb_to_recordset($3::jsonb) as item(
         row_number integer, disposition text, record_key text, data jsonb, rejection_reasons jsonb
       )`,
      [
        input.tenantId,
        run.id,
        JSON.stringify(prepared.landedRows.map((row) => ({
          row_number: row.rowNumber,
          disposition: row.disposition,
          record_key: row.recordKey,
          data: row.data,
          rejection_reasons: row.rejectionReasons,
        }))),
      ],
    );
  }

  if (input.pipeline.loadMode === "snapshot") {
    await client.query("delete from public.curated_records where pipeline_id = $1", [input.pipeline.id]);
  }
  if (prepared.curatedRecords.length > 0) {
    await client.query(
      `insert into public.curated_records
         (tenant_id, pipeline_id, record_key, data, source_run_id, source_row_number)
       select $1, $2, item.record_key, item.data, $3, item.row_number
       from jsonb_to_recordset($4::jsonb) as item(record_key text, row_number integer, data jsonb)
       on conflict (pipeline_id, record_key) do update set
         data = excluded.data,
         source_run_id = excluded.source_run_id,
         source_row_number = excluded.source_row_number,
         is_deleted = false,
         deleted_at = null,
         last_seen_at = now()`,
      [
        input.tenantId,
        input.pipeline.id,
        run.id,
        JSON.stringify(prepared.curatedRecords.map((row) => ({
          record_key: row.recordKey,
          row_number: row.rowNumber,
          data: row.data,
        }))),
      ],
    );
  }

  await client.query(
    `insert into public.validation_results
       (tenant_id, run_id, rule_key, rule_type, severity, status, affected_rows, message)
     values ($1, $2, 'row_contract', 'custom', 'warning', $3, $4, $5)`,
    [
      input.tenantId,
      run.id,
      prepared.rejectedRows > 0 ? "failed" : "passed",
      prepared.rejectedRows,
      prepared.rejectedRows > 0
        ? `${prepared.rejectedRows} rows were quarantined by required fields, type conversion or load-key checks.`
        : "All source rows passed the configured mapping, type, required-field and load-key checks.",
    ],
  );
  await client.query(
    `insert into public.pipeline_run_steps
       (tenant_id, run_id, step_key, status, started_at, finished_at, rows_in, rows_out, message)
     values ($1, $2, 'load', $3, now(), now(), $4, $5, $6)`,
    [
      input.tenantId,
      run.id,
      status,
      prepared.landedRows.length,
      prepared.curatedRecords.length,
      `${prepared.curatedRecords.length} accepted; ${prepared.rejectedRows} quarantined`,
    ],
  );
  await client.query(
    `update public.pipeline_runs set
       status = $2,
       finished_at = now(),
       rows_received = $3,
       rows_accepted = $4,
       rows_rejected = $5
     where id = $1`,
    [run.id, status, prepared.landedRows.length, prepared.curatedRecords.length, prepared.rejectedRows],
  );

  return {
    runId: run.id,
    status,
    duplicate: false,
    sourceObjectReused: sourceBatch.reused,
    acceptedRows: prepared.curatedRecords.length,
    rejectedRows: prepared.rejectedRows,
  };
}

export async function persistManualFileFailure(
  client: PoolClient,
  input: TabularFileSourceInput & { actorUserId: string; errorMessage: string },
): Promise<{ runId: string; duplicate: boolean; sourceObjectReused: boolean }> {
  const sourceBatch = await resolveManualFileBatch(client, {
    ...input,
    metadata: { ...input.sourceMetadata, processingError: input.errorMessage },
  });
  await lockPipelineBatch(client, input.pipeline.id, sourceBatch.id);
  const existingRun = await findCompletedRun(client, input.pipeline.id, sourceBatch.id);
  if (existingRun) {
    return { runId: existingRun.id, duplicate: true, sourceObjectReused: sourceBatch.reused };
  }
  const { rows: [run] } = await client.query(
    `insert into public.pipeline_runs
       (tenant_id, pipeline_id, connector_id, source_batch_id, trigger_type,
        status, initiated_by, started_at, finished_at, error_code, error_message, source_watermark)
     values ($1, $2, $3, $4, $5, 'failed', $6, now(), now(),
             'file_processing_failed', $7, $8)
     returning id`,
    [
      input.tenantId,
      input.pipeline.id,
      input.pipeline.connectorId,
      sourceBatch.id,
      input.triggerType ?? "manual_upload",
      input.actorUserId,
      input.errorMessage.slice(0, 500),
      input.contentSha256,
    ],
  );
  await client.query(
    `insert into public.pipeline_run_steps
       (tenant_id, run_id, step_key, status, started_at, finished_at, message)
     values ($1, $2, 'parse_and_validate', 'failed', now(), now(), $3)`,
    [input.tenantId, run.id, input.errorMessage.slice(0, 500)],
  );
  return { runId: run.id, duplicate: false, sourceObjectReused: sourceBatch.reused };
}
