import type { PoolClient } from "@neondatabase/serverless";
import { openConnectorValue, sealConnectorValue, sealedValueFromRow } from "./credential-crypto";
import { listPipelineFieldMappings } from "./pipeline-configuration";
import { normalizeDestinationColumnName, type SqlDestinationField, type SqlDestinationRecord } from "./sql-server-destination-api";
import type { SqlServerCredentials } from "./sql-server-api";
import type { SqlServerConnectorType } from "./sql-server-connectors";
import type { PipelineDataType } from "./tabular-load";

export interface SqlDestinationOverview {
  id: string;
  name: string;
  connectorType: SqlServerConnectorType;
  status: string;
  server: string;
  database: string;
  managedSchema: string;
}

export interface PipelineSqlDestinationOverview {
  id: string;
  connectorId: string;
  connectorName: string;
  targetSchema: string;
  targetTable: string;
  status: string;
  lastLoadStatus: string | null;
  lastLoadAt: string | null;
  lastRowsWritten: number | null;
  lastMessage: string | null;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: number;
  nextLoadAt: string | null;
  nextRetryAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface SqlDestinationLoadContext {
  destination: PipelineSqlDestinationOverview;
  credentials: SqlServerCredentials;
  pipelineId: string;
  sourceRunId: string;
  fields: SqlDestinationField[];
  records: SqlDestinationRecord[];
  alreadySucceeded: boolean;
}

function openDestinationCredentials(row: Record<string, unknown>, tenantId: string, connectorId: string): SqlServerCredentials {
  const credentials = openConnectorValue<SqlServerCredentials>(
    sealedValueFromRow(row),
    "credentials",
    `${tenantId}:${connectorId}`,
  );
  if (!credentials.server || !credentials.database || !credentials.username || !credentials.password || !credentials.port) {
    throw new Error("The SQL destination credential payload is incomplete.");
  }
  return credentials;
}

export async function createSqlServerDestination(
  client: PoolClient,
  input: {
    tenantId: string;
    createdBy: string;
    name: string;
    connectorType: SqlServerConnectorType;
    credentials: SqlServerCredentials;
    managedSchema: string;
    serverVersion: string;
  },
): Promise<{ connectorId: string }> {
  const config = {
    direction: "destination",
    server: input.credentials.server,
    port: input.credentials.port,
    database: input.credentials.database,
    managedSchema: input.managedSchema,
    serverVersion: input.serverVersion,
    networkMode: "hosted",
    tls: { encrypt: true, trustServerCertificate: false },
  };
  const { rows: [connector] } = await client.query(
    `insert into public.connectors
       (tenant_id, connector_type, name, status, auth_mode, config, created_by,
        last_tested_at, last_test_status, last_test_message)
     values ($1, $2, $3, 'active', 'connection_string', $4::jsonb, $5,
             now(), 'succeeded', 'Schema-scoped SQL destination connected')
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

export async function listSqlServerDestinations(
  client: PoolClient,
  input: { tenantId: string },
): Promise<SqlDestinationOverview[]> {
  const { rows } = await client.query(
    `select id, name, connector_type, status, config
       from public.connectors
      where tenant_id = $1
        and connector_type in ('sql_server', 'azure_sql')
        and config ->> 'direction' = 'destination'
        and status <> 'disabled'
      order by created_at desc`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    connectorType: row.connector_type,
    status: row.status,
    server: String(row.config.server ?? ""),
    database: String(row.config.database ?? ""),
    managedSchema: String(row.config.managedSchema ?? ""),
  }));
}

export async function configurePipelineSqlDestination(
  client: PoolClient,
  input: {
    tenantId: string;
    pipelineId: string;
    connectorId: string;
    targetTable: string;
    createdBy: string;
    scheduleIntervalMinutes: number | null;
  },
): Promise<{ destinationId: string }> {
  if (
    input.scheduleIntervalMinutes !== null
    && ![60, 180, 360, 720, 1440].includes(input.scheduleIntervalMinutes)
  ) {
    throw new Error("Choose a supported SQL workbench delivery schedule.");
  }
  const { rows: [row] } = await client.query(
    `select c.config ->> 'managedSchema' as managed_schema
       from public.connectors c
       join public.pipelines p on p.id = $1 and p.tenant_id = c.tenant_id
       join public.connectors source on source.id = p.connector_id and source.tenant_id = p.tenant_id
      where c.id = $2 and c.tenant_id = $3
        and c.connector_type in ('sql_server', 'azure_sql')
        and c.config ->> 'direction' = 'destination'
        and c.status = 'active'
        and not (
          source.connector_type in ('sql_server', 'azure_sql')
          and coalesce(source.config ->> 'direction', 'source') = 'source'
        )`,
    [input.pipelineId, input.connectorId, input.tenantId],
  );
  if (!row?.managed_schema) {
    throw new Error("The source pipeline or SQL workbench destination was not found. SQL publication pipelines cannot loop back into a destination.");
  }
  const { rows: [existing] } = await client.query(
    `select d.connector_id, d.target_schema, d.target_table, d.lease_expires_at,
            exists (
              select 1 from public.pipeline_sql_destination_runs r
               where r.destination_id = d.id and r.tenant_id = d.tenant_id and r.status = 'succeeded'
            ) as has_succeeded
       from public.pipeline_sql_destinations d
      where d.pipeline_id = $1 and d.tenant_id = $2
      for update`,
    [input.pipelineId, input.tenantId],
  );
  if (existing?.lease_expires_at && new Date(existing.lease_expires_at).valueOf() > Date.now()) {
    throw new Error("The SQL workbench target cannot be reconfigured while a load is active.");
  }
  if (
    existing?.has_succeeded === true
    && (
      existing.connector_id !== input.connectorId
      || existing.target_schema.toLocaleLowerCase("en-GB") !== String(row.managed_schema).toLocaleLowerCase("en-GB")
      || existing.target_table.toLocaleLowerCase("en-GB") !== input.targetTable.toLocaleLowerCase("en-GB")
    )
  ) {
    throw new Error("A successfully loaded SQL target cannot be silently repointed. Create an audited cutover workflow first.");
  }
  const { rows: [destination] } = await client.query(
    `insert into public.pipeline_sql_destinations
       (tenant_id, pipeline_id, connector_id, target_schema, target_table, created_by,
        schedule_enabled, schedule_interval_minutes, next_load_at)
     values ($1, $2, $3, $4, $5, $6, $7::integer is not null,
             coalesce($7::integer, 60), case when $7::integer is not null then now() else null end)
     on conflict (pipeline_id) do update set
       connector_id = excluded.connector_id,
       target_schema = excluded.target_schema,
       target_table = excluded.target_table,
       schedule_enabled = excluded.schedule_enabled,
       schedule_interval_minutes = excluded.schedule_interval_minutes,
       next_load_at = excluded.next_load_at,
       next_retry_at = null,
       lease_token = null,
       lease_expires_at = null,
       status = 'active',
       updated_at = now()
     returning id`,
    [
      input.tenantId,
      input.pipelineId,
      input.connectorId,
      row.managed_schema,
      input.targetTable,
      input.createdBy,
      input.scheduleIntervalMinutes,
    ],
  );
  return { destinationId: destination.id };
}

export async function getPipelineSqlDestination(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<PipelineSqlDestinationOverview | null> {
  const { rows: [row] } = await client.query(
    `select d.id, d.connector_id, c.name as connector_name,
            d.target_schema, d.target_table, d.status,
            latest.status as last_load_status, latest.finished_at as last_load_at,
            latest.rows_written, latest.message,
            d.schedule_enabled, d.schedule_interval_minutes,
            d.next_load_at, d.next_retry_at, d.last_success_at,
            d.last_error, d.consecutive_failures
       from public.pipeline_sql_destinations d
       join public.connectors c on c.id = d.connector_id and c.tenant_id = d.tenant_id
       left join lateral (
         select r.status, r.finished_at, r.rows_written, r.message
           from public.pipeline_sql_destination_runs r
          where r.destination_id = d.id and r.tenant_id = d.tenant_id
          order by r.started_at desc
          limit 1
       ) latest on true
      where d.pipeline_id = $1 and d.tenant_id = $2`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) return null;
  return {
    id: row.id,
    connectorId: row.connector_id,
    connectorName: row.connector_name,
    targetSchema: row.target_schema,
    targetTable: row.target_table,
    status: row.status,
    lastLoadStatus: row.last_load_status,
    lastLoadAt: row.last_load_at ? new Date(row.last_load_at).toISOString() : null,
    lastRowsWritten: row.rows_written === null ? null : Number(row.rows_written),
    lastMessage: row.message,
    scheduleEnabled: row.schedule_enabled,
    scheduleIntervalMinutes: Number(row.schedule_interval_minutes),
    nextLoadAt: row.next_load_at ? new Date(row.next_load_at).toISOString() : null,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    lastError: row.last_error,
    consecutiveFailures: Number(row.consecutive_failures),
  };
}

export async function acquireSqlDestinationLoadLease(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<{ destinationId: string; leaseToken: string }> {
  const { rows: [row] } = await client.query(
    `update public.pipeline_sql_destinations set
       lease_token = gen_random_uuid(),
       lease_expires_at = now() + interval '15 minutes',
       last_attempt_at = now(),
       updated_at = now()
     where pipeline_id = $1 and tenant_id = $2 and status = 'active'
       and (lease_expires_at is null or lease_expires_at <= now())
     returning id, lease_token`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("This SQL workbench target is already loading or is not active.");
  return { destinationId: row.id, leaseToken: row.lease_token };
}

function inferDataType(values: unknown[]): PipelineDataType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return "string";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "number" && Number.isSafeInteger(value))) return "integer";
  if (present.every((value) => typeof value === "number" && Number.isFinite(value))) return "numeric";
  return "string";
}

export async function beginSqlDestinationLoad(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string; destinationId: string; leaseToken: string },
): Promise<SqlDestinationLoadContext> {
  // Serialise the workbench snapshot with source-state commits so the selected
  // source revision and its current records form one coherent lineage point.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`pipeline-state:${input.pipelineId}`]);
  const { rows: [row] } = await client.query(
    `select d.id as destination_id, d.connector_id, c.name as connector_name,
            d.target_schema, d.target_table, d.status,
            d.schedule_enabled, d.schedule_interval_minutes,
            d.next_load_at, d.next_retry_at, d.last_success_at,
            d.last_error, d.consecutive_failures,
            cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version,
            latest.id as source_run_id,
            destination_run.status as destination_run_status,
            destination_run.started_at as destination_run_started_at
       from public.pipeline_sql_destinations d
       join public.connectors c
         on c.id = d.connector_id and c.tenant_id = d.tenant_id
        and c.config ->> 'direction' = 'destination' and c.status = 'active'
       join public.connector_credentials cc
         on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
       join lateral (
         select pr.id
           from public.pipeline_runs pr
          where pr.pipeline_id = d.pipeline_id and pr.tenant_id = d.tenant_id
            and pr.status in ('succeeded', 'warning')
          order by pr.finished_at desc
          limit 1
       ) latest on true
       left join public.pipeline_sql_destination_runs destination_run
         on destination_run.destination_id = d.id
        and destination_run.source_run_id = latest.id
        and destination_run.tenant_id = d.tenant_id
      where d.pipeline_id = $1 and d.tenant_id = $2 and d.status = 'active'
        and d.id = $3 and d.lease_token = $4 and d.lease_expires_at > now()
      for update of d`,
    [input.pipelineId, input.tenantId, input.destinationId, input.leaseToken],
  );
  if (!row) throw new Error("Configure an active SQL destination after the source pipeline has a successful run.");
  const overview: PipelineSqlDestinationOverview = {
    id: row.destination_id,
    connectorId: row.connector_id,
    connectorName: row.connector_name,
    targetSchema: row.target_schema,
    targetTable: row.target_table,
    status: row.status,
    lastLoadStatus: row.destination_run_status,
    lastLoadAt: null,
    lastRowsWritten: null,
    lastMessage: null,
    scheduleEnabled: row.schedule_enabled,
    scheduleIntervalMinutes: Number(row.schedule_interval_minutes),
    nextLoadAt: row.next_load_at ? new Date(row.next_load_at).toISOString() : null,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    lastError: row.last_error,
    consecutiveFailures: Number(row.consecutive_failures),
  };
  if (row.destination_run_status === "succeeded") {
    return {
      destination: overview,
      credentials: openDestinationCredentials(row, input.tenantId, row.connector_id),
      pipelineId: input.pipelineId,
      sourceRunId: row.source_run_id,
      fields: [],
      records: [],
      alreadySucceeded: true,
    };
  }
  if (
    row.destination_run_status === "running"
    && row.destination_run_started_at
    && Date.now() - new Date(row.destination_run_started_at).valueOf() < 15 * 60 * 1_000
  ) {
    throw new Error("This source revision is already loading to SQL. Retry only if it has remained stuck for 15 minutes.");
  }

  const { rows: records } = await client.query(
    `select record_key, source_run_id, data
       from public.curated_records
      where pipeline_id = $1 and tenant_id = $2 and not is_deleted
      order by record_key
      limit 100001`,
    [input.pipelineId, input.tenantId],
  );
  if (records.length === 0) throw new Error("The current governed source state is empty; the previous SQL target was preserved.");
  if (records.length > 100_000) throw new Error("The SQL workbench snapshot exceeds 100,000 rows.");
  const mappings = (await listPipelineFieldMappings(client, input)).filter((mapping) => mapping.isIncluded);
  const sourceFields = mappings.length > 0
    ? mappings.map((mapping) => ({ name: mapping.targetField, dataType: mapping.dataType }))
    : [...new Set(records.flatMap((record) => Object.keys(record.data as Record<string, unknown>)))].map((name) => ({
        name,
        dataType: inferDataType(records.map((record) => (record.data as Record<string, unknown>)[name])),
      }));
  if (sourceFields.length === 0 || sourceFields.length > 250) throw new Error("The current dataset must expose between 1 and 250 fields.");
  const used = new Set<string>();
  const fields = sourceFields.map((field) => ({
    sourceField: field.name,
    targetColumn: normalizeDestinationColumnName(field.name, used),
    dataType: field.dataType,
  }));

  await client.query(
    `insert into public.pipeline_sql_destination_runs
       (tenant_id, destination_id, source_run_id, status)
     values ($1, $2, $3, 'running')
     on conflict (destination_id, source_run_id) do update set
       status = 'running', attempt = public.pipeline_sql_destination_runs.attempt + 1,
       rows_written = 0, started_at = now(), finished_at = null, message = null`,
    [input.tenantId, row.destination_id, row.source_run_id],
  );
  return {
    destination: overview,
    credentials: openDestinationCredentials(row, input.tenantId, row.connector_id),
    pipelineId: input.pipelineId,
    sourceRunId: row.source_run_id,
    fields,
    records: records.map((record) => ({
      recordKey: record.record_key,
      sourceRunId: record.source_run_id,
      data: record.data,
    })),
    alreadySucceeded: false,
  };
}

export async function completeSqlDestinationLoad(
  client: PoolClient,
  input: { tenantId: string; destinationId: string; sourceRunId: string; leaseToken: string; rowsWritten: number; message: string },
): Promise<void> {
  const run = await client.query(
    `update public.pipeline_sql_destination_runs set
       status = 'succeeded', rows_written = $4, message = $5, finished_at = now()
      where destination_id = $1 and source_run_id = $2 and tenant_id = $3 and status = 'running'`,
    [input.destinationId, input.sourceRunId, input.tenantId, input.rowsWritten, input.message.slice(0, 500)],
  );
  if (run.rowCount !== 1) throw new Error("The SQL destination load ledger changed while the load was running.");
  const destination = await client.query(
    `update public.pipeline_sql_destinations set
       last_success_at = now(), last_error = null, consecutive_failures = 0,
       next_retry_at = null,
       next_load_at = case when schedule_enabled
         then now() + make_interval(mins => schedule_interval_minutes)
         else null end,
       lease_token = null, lease_expires_at = null, updated_at = now()
     where id = $1 and tenant_id = $2 and lease_token = $3
     returning id`,
    [input.destinationId, input.tenantId, input.leaseToken],
  );
  if (destination.rowCount !== 1) throw new Error("The SQL destination lease expired before the successful load was recorded.");
}

export async function completeSqlDestinationNoop(
  client: PoolClient,
  input: { tenantId: string; destinationId: string; leaseToken: string },
): Promise<void> {
  const result = await client.query(
    `update public.pipeline_sql_destinations set
       last_error = null, consecutive_failures = 0, next_retry_at = null,
       next_load_at = case when schedule_enabled
         then now() + make_interval(mins => schedule_interval_minutes)
         else null end,
       lease_token = null, lease_expires_at = null, updated_at = now()
     where id = $1 and tenant_id = $2 and lease_token = $3
     returning id`,
    [input.destinationId, input.tenantId, input.leaseToken],
  );
  if (result.rowCount !== 1) throw new Error("The SQL destination lease expired before the unchanged state was recorded.");
}

export async function recordSqlDestinationLoadFailure(
  client: PoolClient,
  input: {
    tenantId: string;
    destinationId: string;
    sourceRunId: string | null;
    leaseToken: string;
    message: string;
  },
): Promise<void> {
  const message = input.message.slice(0, 500);
  if (input.sourceRunId) {
    await client.query(
      `update public.pipeline_sql_destination_runs set
         status = 'failed', rows_written = 0, message = $4, finished_at = now()
       where destination_id = $1 and source_run_id = $2 and tenant_id = $3 and status = 'running'`,
      [input.destinationId, input.sourceRunId, input.tenantId, message],
    );
  }
  const result = await client.query(
    `update public.pipeline_sql_destinations set
       last_error = $4,
       consecutive_failures = consecutive_failures + 1,
       next_retry_at = now() + make_interval(
         mins => least(60, power(2, least(consecutive_failures, 5))::integer * 5)
       ),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where id = $1 and tenant_id = $2 and lease_token = $3
     returning id`,
    [input.destinationId, input.tenantId, input.leaseToken, message],
  );
  if (result.rowCount !== 1) throw new Error("The SQL destination lease expired before the failure was recorded.");
}
