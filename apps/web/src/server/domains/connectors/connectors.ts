import type { PoolClient } from "@neondatabase/serverless";

export interface ConnectorOverview {
  id: string;
  name: string;
  connectorType: string;
  status: string;
  pipelineCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
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
