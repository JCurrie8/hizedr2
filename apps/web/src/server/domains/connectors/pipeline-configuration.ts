import type { PoolClient } from "@neondatabase/serverless";
import type { LoadMode, PipelineDataType, PipelineFieldMapping } from "./tabular-load";

const DATA_TYPES = new Set<PipelineDataType>(["string", "integer", "numeric", "boolean", "date", "timestamp"]);
const FORBIDDEN_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

export interface PipelineBuilderConfiguration {
  id: string;
  name: string;
  status: string;
  connectorId: string;
  connectorName: string;
  connectorType: string;
  loadMode: LoadMode;
  keyColumns: string[];
  sourceConfig: Record<string, unknown>;
  discoveredHeaders: string[];
  fieldMappings: PipelineFieldMapping[];
  pollIntervalMinutes: number | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  versionNumber: number;
}

function mapFieldMapping(row: Record<string, unknown>): PipelineFieldMapping {
  return {
    sourceField: String(row.source_field),
    targetField: String(row.target_field),
    dataType: row.data_type as PipelineDataType,
    isIncluded: Boolean(row.is_included),
    isRequired: Boolean(row.is_required),
    position: Number(row.position),
  };
}

export async function listPipelineFieldMappings(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<PipelineFieldMapping[]> {
  const { rows } = await client.query(
    `select source_field, target_field, data_type, is_included, is_required, position
     from public.pipeline_field_mappings
     where tenant_id = $1 and pipeline_id = $2
     order by position, id`,
    [input.tenantId, input.pipelineId],
  );
  return rows.map(mapFieldMapping);
}

export async function getPipelineBuilderConfiguration(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<PipelineBuilderConfiguration> {
  const { rows: [row] } = await client.query(
    `select p.id, p.name, p.status, p.connector_id, p.load_mode, p.key_columns,
            p.source_config, c.name as connector_name, c.connector_type,
            css.poll_interval_minutes,
            latest_run.status as last_run_status, latest_run.queued_at as last_run_at,
            coalesce(latest_run.headers, '[]'::jsonb) as discovered_headers,
            coalesce(version.version_number, 0)::integer as version_number
     from public.pipelines p
     join public.connectors c
       on c.id = p.connector_id and c.tenant_id = p.tenant_id
     left join public.connector_sync_state css
       on css.connector_id = c.id and css.tenant_id = c.tenant_id
     left join lateral (
       select pr.status, pr.queued_at, sb.metadata -> 'headers' as headers
       from public.pipeline_runs pr
       join public.source_batches sb
         on sb.id = pr.source_batch_id and sb.tenant_id = pr.tenant_id
       where pr.pipeline_id = p.id and pr.tenant_id = p.tenant_id
         and jsonb_typeof(sb.metadata -> 'headers') = 'array'
       order by pr.queued_at desc
       limit 1
     ) latest_run on true
     left join lateral (
       select pcv.version_number
       from public.pipeline_config_versions pcv
       where pcv.pipeline_id = p.id and pcv.tenant_id = p.tenant_id
       order by pcv.version_number desc
       limit 1
     ) version on true
     where p.id = $1 and p.tenant_id = $2 and p.status <> 'disabled'
       and c.status <> 'disabled'`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("The pipeline was not found or is disabled.");

  const storedMappings = await listPipelineFieldMappings(client, input);
  const discoveredHeaders = Array.isArray(row.discovered_headers)
    ? row.discovered_headers.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const fieldMappings = storedMappings.length > 0
    ? storedMappings
    : discoveredHeaders.map((header: string, position: number) => ({
      sourceField: header,
      targetField: header,
      dataType: "string" as const,
      isIncluded: true,
      isRequired: false,
      position,
    }));

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    connectorId: row.connector_id,
    connectorName: row.connector_name,
    connectorType: row.connector_type,
    loadMode: row.load_mode,
    keyColumns: row.key_columns,
    sourceConfig: row.source_config,
    discoveredHeaders,
    fieldMappings,
    pollIntervalMinutes: row.poll_interval_minutes === null ? null : Number(row.poll_interval_minutes),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastRunStatus: row.last_run_status ?? null,
    versionNumber: row.version_number,
  };
}

function validateFieldName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) throw new Error(`${label} must be between 1 and 200 characters.`);
  if (FORBIDDEN_FIELDS.has(trimmed.toLocaleLowerCase("en-GB"))) throw new Error(`${label} '${trimmed}' is reserved.`);
  return trimmed;
}

export async function savePipelineBuilderConfiguration(
  client: PoolClient,
  input: {
    tenantId: string;
    pipelineId: string;
    actorUserId: string;
    name: string;
    loadMode: LoadMode;
    keyColumns: string[];
    fieldMappings: PipelineFieldMapping[];
    pollIntervalMinutes: number | null;
    changeNote: string | null;
  },
): Promise<{ versionNumber: number; connectorType: string }> {
  const { rows: [pipeline] } = await client.query(
    `select p.id, p.connector_id, p.source_config, c.connector_type
     from public.pipelines p
     join public.connectors c on c.id = p.connector_id and c.tenant_id = p.tenant_id
     where p.id = $1 and p.tenant_id = $2 and p.status <> 'disabled' and c.status <> 'disabled'
     for update of p`,
    [input.pipelineId, input.tenantId],
  );
  if (!pipeline) throw new Error("The pipeline was not found or is disabled.");

  const name = input.name.trim();
  if (name.length < 2 || name.length > 100) throw new Error("Pipeline name must be between 2 and 100 characters.");
  if (!(["snapshot", "append", "upsert"] as LoadMode[]).includes(input.loadMode)) throw new Error("Invalid load mode.");

  const { rows: [headerRow] } = await client.query(
    `select sb.metadata -> 'headers' as headers
     from public.pipeline_runs pr
     join public.source_batches sb on sb.id = pr.source_batch_id and sb.tenant_id = pr.tenant_id
     where pr.pipeline_id = $1 and pr.tenant_id = $2
       and jsonb_typeof(sb.metadata -> 'headers') = 'array'
     order by pr.queued_at desc
     limit 1`,
    [input.pipelineId, input.tenantId],
  );
  const discoveredHeaders: string[] = Array.isArray(headerRow?.headers) ? headerRow.headers : [];
  const discovered = new Set(discoveredHeaders.map((header) => header.toLocaleLowerCase("en-GB")));
  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  const fieldMappings = input.fieldMappings.map((mapping, position) => {
    const sourceField = validateFieldName(mapping.sourceField, "Source field");
    const targetField = validateFieldName(mapping.targetField, "Target field");
    const sourceKey = sourceField.toLocaleLowerCase("en-GB");
    const targetKey = targetField.toLocaleLowerCase("en-GB");
    if (discovered.size > 0 && !discovered.has(sourceKey)) throw new Error(`Source field '${sourceField}' was not discovered in the latest run.`);
    if (seenSources.has(sourceKey)) throw new Error(`Source field '${sourceField}' is configured more than once.`);
    if (mapping.isIncluded && seenTargets.has(targetKey)) throw new Error(`Target field '${targetField}' is configured more than once.`);
    if (!DATA_TYPES.has(mapping.dataType)) throw new Error(`Invalid data type for '${targetField}'.`);
    if (mapping.isRequired && !mapping.isIncluded) throw new Error(`Required field '${targetField}' must be included.`);
    seenSources.add(sourceKey);
    if (mapping.isIncluded) seenTargets.add(targetKey);
    return { ...mapping, sourceField, targetField, position };
  });
  if (fieldMappings.length > 0 && !fieldMappings.some((mapping) => mapping.isIncluded)) {
    throw new Error("Include at least one field in the governed dataset.");
  }

  const keyColumns = [...new Set(input.keyColumns.map((column) => validateFieldName(column, "Key field")))];
  const includedTargets = new Set(fieldMappings.filter((mapping) => mapping.isIncluded).map((mapping) => mapping.targetField.toLocaleLowerCase("en-GB")));
  const unknownKeys = keyColumns.filter((column) => fieldMappings.length > 0 && !includedTargets.has(column.toLocaleLowerCase("en-GB")));
  if (unknownKeys.length > 0) throw new Error(`Load keys must be included target fields: ${unknownKeys.join(", ")}.`);
  if (input.loadMode === "upsert" && keyColumns.length === 0) throw new Error("Upsert pipelines require at least one load key.");

  const pollIntervalMinutes = pipeline.connector_type === "sharepoint" ? input.pollIntervalMinutes : null;
  if (pollIntervalMinutes !== null && (!Number.isInteger(pollIntervalMinutes) || pollIntervalMinutes < 60 || pollIntervalMinutes > 1440)) {
    throw new Error("Microsoft polling must be between one hour and 24 hours.");
  }
  const scheduleCron = pollIntervalMinutes === null
    ? null
    : pollIntervalMinutes < 60
      ? `*/${pollIntervalMinutes} * * * *`
      : pollIntervalMinutes === 60
        ? "0 * * * *"
        : pollIntervalMinutes === 1440
          ? "0 0 * * *"
          : `0 */${pollIntervalMinutes / 60} * * *`;

  await client.query(
    `update public.pipelines set name = $3, load_mode = $4, key_columns = $5::text[],
       schedule_cron = $6, updated_at = now()
     where id = $1 and tenant_id = $2`,
    [input.pipelineId, input.tenantId, name, input.loadMode, keyColumns, scheduleCron],
  );
  await client.query(
    `delete from public.pipeline_field_mappings where pipeline_id = $1 and tenant_id = $2`,
    [input.pipelineId, input.tenantId],
  );
  if (fieldMappings.length > 0) {
    await client.query(
      `insert into public.pipeline_field_mappings
         (tenant_id, pipeline_id, source_field, target_field, data_type, is_included, is_required, position)
       select $1, $2, item.source_field, item.target_field, item.data_type,
              item.is_included, item.is_required, item.position
       from jsonb_to_recordset($3::jsonb) as item(
         source_field text, target_field text, data_type text,
         is_included boolean, is_required boolean, position integer
       )`,
      [input.tenantId, input.pipelineId, JSON.stringify(fieldMappings.map((mapping) => ({
        source_field: mapping.sourceField,
        target_field: mapping.targetField,
        data_type: mapping.dataType,
        is_included: mapping.isIncluded,
        is_required: mapping.isRequired,
        position: mapping.position,
      })))],
    );
  }
  if (pollIntervalMinutes !== null) {
    await client.query(
      `update public.connector_sync_state set poll_interval_minutes = $3,
         next_poll_at = least(next_poll_at, now() + make_interval(mins => $3)), updated_at = now()
       where connector_id = $1 and tenant_id = $2`,
      [pipeline.connector_id, input.tenantId, pollIntervalMinutes],
    );
  }

  const { rows: [version] } = await client.query(
    `select coalesce(max(version_number), 0)::integer + 1 as next_version
     from public.pipeline_config_versions where pipeline_id = $1 and tenant_id = $2`,
    [input.pipelineId, input.tenantId],
  );
  const configuration = {
    name,
    connectorType: pipeline.connector_type,
    sourceConfig: pipeline.source_config,
    loadMode: input.loadMode,
    keyColumns,
    fieldMappings,
    pollIntervalMinutes,
  };
  await client.query(
    `insert into public.pipeline_config_versions
       (tenant_id, pipeline_id, version_number, configuration, change_note, created_by)
     values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [input.tenantId, input.pipelineId, version.next_version, JSON.stringify(configuration), input.changeNote, input.actorUserId],
  );
  return { versionNumber: version.next_version, connectorType: pipeline.connector_type };
}
