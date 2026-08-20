import type { PoolClient } from "@neondatabase/serverless";
import { openConnectorValue, sealConnectorValue, sealedValueFromRow } from "./credential-crypto";
import type {
  SqlServerCredentials,
  SqlServerFieldSummary,
  SqlServerObjectDescription,
  SqlServerObjectSummary,
} from "./sql-server-api";
import { listPipelineFieldMappings } from "./pipeline-configuration";
import type { LoadMode, PipelineFieldMapping } from "./tabular-load";

export type SqlServerConnectorType = "sql_server" | "azure_sql";

export interface SqlServerPipelineOverview {
  id: string;
  name: string;
  schema: string;
  object: string;
  loadMode: LoadMode;
  lastSuccessAt: string | null;
}

export interface SqlServerConnectorOverview {
  id: string;
  name: string;
  connectorType: SqlServerConnectorType;
  status: string;
  server: string;
  database: string;
  serverVersion: string;
  catalog: SqlServerObjectSummary[];
  pipelines: SqlServerPipelineOverview[];
}

export interface SqlServerSyncContext {
  connectorId: string;
  connectorType: SqlServerConnectorType;
  credentials: SqlServerCredentials;
  pipeline: {
    id: string;
    connectorId: string;
    name: string;
    loadMode: LoadMode;
    keyColumns: string[];
    fieldMappings: PipelineFieldMapping[];
  };
  schema: string;
  object: string;
  fields: string[];
  watermarkField: string | null;
  overlapSeconds: number;
  committedThroughAt: string | null;
}

function parseCatalog(value: unknown): SqlServerObjectSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.schema !== "string" || typeof item.name !== "string") return [];
    if (item.objectType !== "table" && item.objectType !== "view") return [];
    return [{ schema: item.schema, name: item.name, objectType: item.objectType }];
  });
}

function openCredentials(row: Record<string, unknown>, input: { tenantId: string; connectorId: string }): SqlServerCredentials {
  const credentials = openConnectorValue<SqlServerCredentials>(
    sealedValueFromRow(row),
    "credentials",
    `${input.tenantId}:${input.connectorId}`,
  );
  if (!credentials.server || !credentials.database || !credentials.username || !credentials.password || !credentials.port) {
    throw new Error("The SQL Server credential payload is incomplete.");
  }
  return credentials;
}

export async function createSqlServerConnector(
  client: PoolClient,
  input: {
    tenantId: string;
    createdBy: string;
    name: string;
    connectorType: SqlServerConnectorType;
    credentials: SqlServerCredentials;
    serverVersion: string;
    catalog: SqlServerObjectSummary[];
  },
): Promise<{ connectorId: string }> {
  const config = {
    server: input.credentials.server,
    port: input.credentials.port,
    database: input.credentials.database,
    serverVersion: input.serverVersion,
    networkMode: "hosted",
    tls: { encrypt: true, trustServerCertificate: false },
    catalog: input.catalog,
    catalogRefreshedAt: new Date().toISOString(),
  };
  const { rows: [connector] } = await client.query(
    `insert into public.connectors
       (tenant_id, connector_type, name, status, auth_mode, config, created_by,
        last_tested_at, last_test_status, last_test_message)
     values ($1, $2, $3, 'active', 'connection_string', $4::jsonb, $5,
             now(), 'succeeded', 'Read-only SQL Server login connected')
     returning id`,
    [input.tenantId, input.connectorType, input.name, JSON.stringify(config), input.createdBy],
  );
  const sealed = sealConnectorValue(input.credentials, "credentials", `${input.tenantId}:${connector.id}`);
  await client.query(
    `insert into public.connector_credentials
       (tenant_id, connector_id, ciphertext, iv, auth_tag, key_version, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [input.tenantId, connector.id, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, input.createdBy],
  );
  return { connectorId: connector.id };
}

export async function listSqlServerConnectors(
  client: PoolClient,
  input: { tenantId: string },
): Promise<SqlServerConnectorOverview[]> {
  const { rows } = await client.query(
    `select c.id, c.name, c.connector_type, c.status, c.config,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.name,
              'schema', p.source_config ->> 'schema',
              'object', p.source_config ->> 'object',
              'loadMode', p.load_mode,
              'lastSuccessAt', latest.succeeded_at
            ) order by p.created_at) filter (where p.id is not null), '[]'::jsonb) as pipelines
       from public.connectors c
       left join public.pipelines p
         on p.connector_id = c.id and p.tenant_id = c.tenant_id and p.status <> 'disabled'
       left join lateral (
         select max(run.finished_at) as succeeded_at
           from public.pipeline_runs run
          where run.pipeline_id = p.id and run.tenant_id = p.tenant_id
            and run.status in ('succeeded', 'warning')
       ) latest on true
      where c.tenant_id = $1 and c.connector_type in ('sql_server', 'azure_sql')
        and c.status <> 'disabled'
      group by c.id
      order by c.created_at desc`,
    [input.tenantId],
  );
  return rows.map((row) => {
    const config = row.config as Record<string, unknown>;
    const pipelines = (Array.isArray(row.pipelines) ? row.pipelines : []) as Array<Record<string, unknown>>;
    return {
      id: row.id,
      name: row.name,
      connectorType: row.connector_type,
      status: row.status,
      server: String(config.server ?? ""),
      database: String(config.database ?? ""),
      serverVersion: String(config.serverVersion ?? ""),
      catalog: parseCatalog(config.catalog),
      pipelines: pipelines.map((pipeline) => ({
        id: String(pipeline.id),
        name: String(pipeline.name),
        schema: String(pipeline.schema),
        object: String(pipeline.object),
        loadMode: pipeline.loadMode as LoadMode,
        lastSuccessAt: pipeline.lastSuccessAt ? new Date(String(pipeline.lastSuccessAt)).toISOString() : null,
      })),
    };
  });
}

export async function getSqlServerCredentials(
  client: PoolClient,
  input: { tenantId: string; connectorId: string },
): Promise<{ credentials: SqlServerCredentials; connectorType: SqlServerConnectorType }> {
  const { rows: [row] } = await client.query(
    `select c.connector_type, cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version
       from public.connectors c
       join public.connector_credentials cc
         on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
      where c.id = $1 and c.tenant_id = $2
        and c.connector_type in ('sql_server', 'azure_sql')
        and c.status in ('active', 'error')`,
    [input.connectorId, input.tenantId],
  );
  if (!row) throw new Error("The SQL Server connection was not found or has no credentials.");
  return {
    credentials: openCredentials(row, input),
    connectorType: row.connector_type,
  };
}

function mappingForField(field: SqlServerFieldSummary, position: number, keyColumns: Set<string>): PipelineFieldMapping {
  return {
    sourceField: field.name,
    targetField: field.name,
    dataType: field.dataType,
    isIncluded: true,
    isRequired: keyColumns.has(field.name),
    position,
  };
}

export async function createSqlServerPipeline(
  client: PoolClient,
  input: {
    tenantId: string;
    connectorId: string;
    createdBy: string;
    pipelineName: string;
    description: SqlServerObjectDescription;
    selectedFields: string[];
    keyColumns: string[];
    watermarkField: string | null;
    loadMode: "snapshot" | "upsert";
    overlapSeconds: number;
  },
): Promise<{ pipelineId: string }> {
  const { rows: [connector] } = await client.query(
    `select id from public.connectors
      where id = $1 and tenant_id = $2
        and connector_type in ('sql_server', 'azure_sql')
        and status in ('active', 'error') for update`,
    [input.connectorId, input.tenantId],
  );
  if (!connector) throw new Error("The SQL Server connection was not found.");
  const fieldByName = new Map(input.description.fields.filter((field) => field.supported).map((field) => [field.name, field]));
  const selected = [...new Set(input.selectedFields)];
  const keyColumns = [...new Set(input.keyColumns)];
  if (selected.length === 0 || selected.length > 250) throw new Error("Select between 1 and 250 supported fields.");
  if (input.loadMode === "upsert" && keyColumns.length === 0) throw new Error("Upsert requires at least one stable key.");
  for (const required of [...keyColumns, ...(input.watermarkField ? [input.watermarkField] : [])]) {
    if (!selected.includes(required)) selected.push(required);
  }
  if (selected.length > 250) throw new Error("Select no more than 250 fields including keys and the watermark.");
  const unknown = selected.filter((field) => !fieldByName.has(field));
  if (unknown.length > 0) throw new Error(`Fields are no longer readable or supported: ${unknown.join(", ")}.`);
  if (input.watermarkField) {
    const watermark = fieldByName.get(input.watermarkField);
    if (!watermark || !["date", "timestamp"].includes(watermark.dataType)) {
      throw new Error("The incremental watermark must be a date or timestamp field.");
    }
    if (keyColumns.length === 0) throw new Error("Incremental extraction requires a stable upsert key.");
  }
  const sourceConfig = {
    schema: input.description.schema,
    object: input.description.name,
    objectType: input.description.objectType,
    fields: selected,
    watermarkField: input.watermarkField,
  };
  const { rows: [pipeline] } = await client.query(
    `insert into public.pipelines
       (tenant_id, connector_id, name, status, source_config, load_mode, key_columns, created_by)
     values ($1, $2, $3, 'active', $4::jsonb, $5, $6::text[], $7)
     returning id`,
    [input.tenantId, input.connectorId, input.pipelineName, JSON.stringify(sourceConfig), input.loadMode, keyColumns, input.createdBy],
  );
  await client.query(
    `insert into public.pipeline_checkpoints
       (pipeline_id, tenant_id, strategy, overlap_seconds)
     values ($1, $2, $3, $4)`,
    [pipeline.id, input.tenantId, input.watermarkField ? "modified_since" : "full_refresh", input.overlapSeconds],
  );
  const keys = new Set(keyColumns);
  const mappings = selected.map((name, position) => mappingForField(fieldByName.get(name)!, position, keys));
  await client.query(
    `insert into public.pipeline_field_mappings
       (tenant_id, pipeline_id, source_field, target_field, data_type,
        is_included, is_required, position)
     select $1, $2, item.source_field, item.target_field, item.data_type,
            item.is_included, item.is_required, item.position
       from jsonb_to_recordset($3::jsonb) as item(
         source_field text, target_field text, data_type text,
         is_included boolean, is_required boolean, position integer
       )`,
    [input.tenantId, pipeline.id, JSON.stringify(mappings.map((mapping) => ({
      source_field: mapping.sourceField,
      target_field: mapping.targetField,
      data_type: mapping.dataType,
      is_included: mapping.isIncluded,
      is_required: mapping.isRequired,
      position: mapping.position,
    })))],
  );
  return { pipelineId: pipeline.id };
}

export async function getSqlServerSyncContext(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<SqlServerSyncContext> {
  const { rows: [row] } = await client.query(
    `select c.id as connector_id, c.connector_type,
            p.id as pipeline_id, p.name as pipeline_name, p.source_config,
            p.load_mode, p.key_columns, pc.overlap_seconds, pc.committed_through_at,
            cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version
       from public.pipelines p
       join public.connectors c on c.id = p.connector_id and c.tenant_id = p.tenant_id
       join public.connector_credentials cc on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
       join public.pipeline_checkpoints pc on pc.pipeline_id = p.id and pc.tenant_id = p.tenant_id
      where p.id = $1 and p.tenant_id = $2 and p.status = 'active'
        and c.connector_type in ('sql_server', 'azure_sql') and c.status in ('active', 'error')`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("The SQL Server pipeline was not found or is not active.");
  const source = row.source_config as Record<string, unknown>;
  const fields = Array.isArray(source.fields) ? source.fields.filter((field): field is string => typeof field === "string") : [];
  if (!source.schema || !source.object || fields.length === 0) throw new Error("The SQL Server pipeline configuration is incomplete.");
  return {
    connectorId: row.connector_id,
    connectorType: row.connector_type,
    credentials: openCredentials(row, { tenantId: input.tenantId, connectorId: row.connector_id }),
    pipeline: {
      id: row.pipeline_id,
      connectorId: row.connector_id,
      name: row.pipeline_name,
      loadMode: row.load_mode,
      keyColumns: row.key_columns,
      fieldMappings: await listPipelineFieldMappings(client, input),
    },
    schema: String(source.schema),
    object: String(source.object),
    fields,
    watermarkField: typeof source.watermarkField === "string" ? source.watermarkField : null,
    overlapSeconds: Number(row.overlap_seconds),
    committedThroughAt: row.committed_through_at ? new Date(row.committed_through_at).toISOString() : null,
  };
}

export async function commitSqlServerCheckpoint(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; pipelineId: string; expected: string | null; committedThroughAt: string },
): Promise<void> {
  const checkpoint = await client.query(
    `update public.pipeline_checkpoints set
       committed_through_at = $3::timestamptz,
       cursor_value = jsonb_build_object('committedThroughAt', ($3::timestamptz)::text),
       updated_at = now()
      where pipeline_id = $1 and tenant_id = $2
        and committed_through_at is not distinct from $4::timestamptz
      returning pipeline_id`,
    [input.pipelineId, input.tenantId, input.committedThroughAt, input.expected],
  );
  if (checkpoint.rowCount !== 1) throw new Error("The SQL Server checkpoint changed while this extract was running.");
  await client.query(
    `update public.connectors set status = 'active', last_tested_at = now(),
       last_test_status = 'succeeded', last_test_message = 'SQL Server extract completed', updated_at = now()
      where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId],
  );
}

export async function recordSqlServerFailure(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; message: string },
): Promise<void> {
  await client.query(
    `update public.connectors set status = 'error', last_tested_at = now(),
       last_test_status = 'failed', last_test_message = $3, updated_at = now()
      where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId, input.message.slice(0, 500)],
  );
}
