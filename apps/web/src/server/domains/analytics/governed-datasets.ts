import type { PoolClient } from "@neondatabase/serverless";
import type { PipelineDataType, PipelineFieldMapping } from "../connectors/tabular-load";

export const GOVERNED_DATA_TYPES = ["text", "integer", "decimal", "boolean", "date", "timestamp"] as const;
export const GOVERNED_FIELD_ROLES = ["identifier", "dimension", "measure", "time"] as const;
export const GOVERNED_AGGREGATIONS = ["sum", "average", "distinct_count", "ratio", "snapshot", "semi_additive"] as const;
export const DATASET_REFRESH_CADENCES = ["hourly", "daily", "weekly", "monthly"] as const;
export const MAX_PROJECTED_FIELDS = 25;

export type GovernedDataType = (typeof GOVERNED_DATA_TYPES)[number];
export type GovernedFieldRole = (typeof GOVERNED_FIELD_ROLES)[number];
export type GovernedAggregation = (typeof GOVERNED_AGGREGATIONS)[number];

/**
 * Field names that normally carry personal or contractual detail. They are
 * marked sensitive on publication so the projection gate excludes them unless
 * a governor deliberately opens them up — the safe direction to be wrong in.
 */
const SENSITIVE_NAME_PATTERN =
  /(email|phone|mobile|address|postcode|post_code|zip|dob|date_of_birth|birth|salary|wage|pay|bank|iban|sort_code|account_number|national_insurance|ni_number|ssn|passport|nhs|medical|health|password|secret|token)/i;

export interface GovernedDatasetFieldInput {
  fieldKey: string;
  sourceField: string;
  name: string;
  description: string;
  dataType: GovernedDataType;
  fieldRole: GovernedFieldRole;
  aggregation: GovernedAggregation | null;
  isSensitive: boolean;
}

export interface GovernedDatasetField extends GovernedDatasetFieldInput {
  id: string;
}

export interface RecordProjectionRule {
  id: string;
  status: "active" | "disabled";
  orgCodeFieldKey: string;
  occurredAtFieldKey: string;
  measureFieldKey: string | null;
  projectedFieldKeys: string[];
  maxRecords: number;
  lastProjectedAt: string | null;
  lastProjectedRecordCount: number;
  lastUnmatchedRecordCount: number;
}

export interface GovernedDatasetGovernance {
  id: string;
  key: string;
  name: string;
  description: string;
  subjectArea: string;
  status: "draft" | "published" | "retired";
  refreshCadence: string;
  sourcePipelineId: string | null;
  sourcePipelineName: string | null;
  curatedRecordCount: number;
  projectedRecordCount: number;
  approvedKpiCount: number;
  fields: GovernedDatasetField[];
  projectionRule: RecordProjectionRule | null;
}

export interface PipelinePublicationCandidate {
  id: string;
  name: string;
  connectorName: string;
  connectorType: string;
  curatedRecordCount: number;
  keyColumns: string[];
  fieldMappings: PipelineFieldMapping[];
  publishedDatasetId: string | null;
}

export function governedDataTypeFor(dataType: PipelineDataType): GovernedDataType {
  if (dataType === "string") return "text";
  if (dataType === "numeric") return "decimal";
  return dataType;
}

/** Converts a pipeline target column into the schema's `^[a-z][a-z0-9_]*$` key shape. */
export function toGovernedFieldKey(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLocaleLowerCase("en-GB")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const key = /^[a-z]/.test(normalized) ? normalized : `field_${normalized}`;
  return key.slice(0, 60).replace(/_$/, "") || "field";
}

/**
 * Proposes the governed catalogue for a pipeline. Every decision here is a
 * default the publishing governor can change before it is stored — nothing is
 * silently derived after publication.
 */
export function deriveDatasetFieldsFromPipeline(
  mappings: readonly PipelineFieldMapping[],
  keyColumns: readonly string[] = [],
): GovernedDatasetFieldInput[] {
  const keySet = new Set(keyColumns.map((column) => column.toLocaleLowerCase("en-GB")));
  const usedKeys = new Set<string>();
  return mappings
    .filter((mapping) => mapping.isIncluded)
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((mapping) => {
      let fieldKey = toGovernedFieldKey(mapping.targetField);
      if (usedKeys.has(fieldKey)) {
        let suffix = 2;
        while (usedKeys.has(`${fieldKey}_${suffix}`)) suffix += 1;
        fieldKey = `${fieldKey}_${suffix}`;
      }
      usedKeys.add(fieldKey);
      const dataType = governedDataTypeFor(mapping.dataType);
      const isIdentifier = keySet.has(mapping.targetField.toLocaleLowerCase("en-GB"));
      const fieldRole: GovernedFieldRole = isIdentifier
        ? "identifier"
        : dataType === "date" || dataType === "timestamp"
          ? "time"
          : dataType === "integer" || dataType === "decimal"
            ? "measure"
            : "dimension";
      return {
        fieldKey,
        sourceField: mapping.targetField,
        name: mapping.targetField,
        description: "",
        dataType,
        fieldRole,
        aggregation: fieldRole === "measure" ? ("sum" as const) : null,
        isSensitive: SENSITIVE_NAME_PATTERN.test(mapping.targetField),
      };
    });
}

export async function listPipelinePublicationCandidates(
  client: PoolClient,
  input: { tenantId: string },
): Promise<PipelinePublicationCandidate[]> {
  const { rows } = await client.query(
    `select pipeline.id, pipeline.name, pipeline.key_columns,
            connector.name as connector_name, connector.connector_type,
            coalesce(curated.record_count, 0)::integer as curated_record_count,
            dataset.id as published_dataset_id
       from public.pipelines pipeline
       join public.connectors connector
         on connector.id = pipeline.connector_id and connector.tenant_id = pipeline.tenant_id
       left join lateral (
         select count(*)::integer as record_count
           from public.curated_records record
          where record.tenant_id = pipeline.tenant_id
            and record.pipeline_id = pipeline.id
            and not record.is_deleted
       ) curated on true
       left join public.governed_datasets dataset
         on dataset.tenant_id = pipeline.tenant_id
        and dataset.source_pipeline_id = pipeline.id
      where pipeline.tenant_id = $1 and pipeline.status <> 'disabled'
      order by pipeline.name`,
    [input.tenantId],
  );
  const candidates: PipelinePublicationCandidate[] = [];
  for (const row of rows) {
    const { rows: mappingRows } = await client.query(
      `select source_field, target_field, data_type, is_included, is_required, position
         from public.pipeline_field_mappings
        where tenant_id = $1 and pipeline_id = $2
        order by position, id`,
      [input.tenantId, row.id],
    );
    candidates.push({
      id: row.id,
      name: row.name,
      connectorName: row.connector_name,
      connectorType: row.connector_type,
      curatedRecordCount: Number(row.curated_record_count),
      keyColumns: row.key_columns ?? [],
      fieldMappings: mappingRows.map((mapping) => ({
        sourceField: String(mapping.source_field),
        targetField: String(mapping.target_field),
        dataType: mapping.data_type as PipelineDataType,
        isIncluded: Boolean(mapping.is_included),
        isRequired: Boolean(mapping.is_required),
        position: Number(mapping.position),
      })),
      publishedDatasetId: row.published_dataset_id ?? null,
    });
  }
  return candidates;
}

export async function listGovernedDatasetGovernance(
  client: PoolClient,
  input: { tenantId: string },
): Promise<GovernedDatasetGovernance[]> {
  const { rows } = await client.query(
    `select dataset.id, dataset.dataset_key, dataset.name, dataset.description,
            dataset.subject_area, dataset.status, dataset.refresh_cadence,
            dataset.source_pipeline_id, pipeline.name as source_pipeline_name,
            coalesce(curated.record_count, 0)::integer as curated_record_count,
            coalesce(projected.record_count, 0)::integer as projected_record_count,
            coalesce(kpis.definition_count, 0)::integer as approved_kpi_count
       from public.governed_datasets dataset
       left join public.pipelines pipeline
         on pipeline.id = dataset.source_pipeline_id and pipeline.tenant_id = dataset.tenant_id
       left join lateral (
         select count(*)::integer as record_count
           from public.curated_records record
          where record.tenant_id = dataset.tenant_id
            and record.pipeline_id = dataset.source_pipeline_id
            and not record.is_deleted
       ) curated on true
       left join lateral (
         select count(*)::integer as record_count
           from public.governed_record_projections projection
          where projection.tenant_id = dataset.tenant_id
            and projection.dataset_id = dataset.id
       ) projected on true
       left join lateral (
         select count(*)::integer as definition_count
           from public.kpi_definitions definition
          where definition.tenant_id = dataset.tenant_id
            and definition.dataset_id = dataset.id
            and definition.approval_status = 'approved'
       ) kpis on true
      where dataset.tenant_id = $1
      order by dataset.subject_area, dataset.name`,
    [input.tenantId],
  );
  if (rows.length === 0) return [];

  const datasetIds = rows.map((row) => row.id);
  const { rows: fieldRows } = await client.query(
    `select id, dataset_id, field_key, source_field, name, description,
            data_type, field_role, aggregation, is_sensitive
       from public.governed_dataset_fields
      where tenant_id = $1 and dataset_id = any($2::uuid[])
      order by field_role, field_key`,
    [input.tenantId, datasetIds],
  );
  const { rows: ruleRows } = await client.query(
    `select id, dataset_id, status, org_code_field_key, occurred_at_field_key,
            measure_field_key, projected_field_keys, max_records,
            extract(epoch from last_projected_at) as last_projected_epoch,
            last_projected_record_count, last_unmatched_record_count
       from public.governed_record_projection_rules
      where tenant_id = $1 and dataset_id = any($2::uuid[])`,
    [input.tenantId, datasetIds],
  );
  const rulesByDataset = new Map<string, RecordProjectionRule>(
    ruleRows.map((row) => [row.dataset_id, {
      id: row.id,
      status: row.status,
      orgCodeFieldKey: row.org_code_field_key,
      occurredAtFieldKey: row.occurred_at_field_key,
      measureFieldKey: row.measure_field_key ?? null,
      projectedFieldKeys: row.projected_field_keys ?? [],
      maxRecords: Number(row.max_records),
      lastProjectedAt: row.last_projected_epoch === null
        ? null
        : new Date(Number(row.last_projected_epoch) * 1_000).toISOString(),
      lastProjectedRecordCount: Number(row.last_projected_record_count),
      lastUnmatchedRecordCount: Number(row.last_unmatched_record_count),
    }]),
  );

  return rows.map((row) => ({
    id: row.id,
    key: row.dataset_key,
    name: row.name,
    description: row.description,
    subjectArea: row.subject_area,
    status: row.status,
    refreshCadence: row.refresh_cadence,
    sourcePipelineId: row.source_pipeline_id ?? null,
    sourcePipelineName: row.source_pipeline_name ?? null,
    curatedRecordCount: Number(row.curated_record_count),
    projectedRecordCount: Number(row.projected_record_count),
    approvedKpiCount: Number(row.approved_kpi_count),
    fields: fieldRows
      .filter((field) => field.dataset_id === row.id)
      .map((field) => ({
        id: field.id,
        fieldKey: field.field_key,
        sourceField: field.source_field ?? field.field_key,
        name: field.name,
        description: field.description,
        dataType: field.data_type as GovernedDataType,
        fieldRole: field.field_role as GovernedFieldRole,
        aggregation: (field.aggregation ?? null) as GovernedAggregation | null,
        isSensitive: Boolean(field.is_sensitive),
      })),
    projectionRule: rulesByDataset.get(row.id) ?? null,
  }));
}

function assertText(value: string, label: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new Error(`${label} must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

export async function publishGovernedDatasetFromPipeline(
  client: PoolClient,
  input: {
    tenantId: string;
    pipelineId: string;
    datasetKey: string;
    name: string;
    description: string;
    subjectArea: string;
    refreshCadence: string;
    expectedLatencyHours: number;
    fields: readonly GovernedDatasetFieldInput[];
    actorUserId: string;
  },
): Promise<{ datasetId: string; fieldCount: number }> {
  const datasetKey = input.datasetKey.trim().toLocaleLowerCase("en-GB");
  if (!/^[a-z][a-z0-9_]*$/.test(datasetKey)) throw new Error("Dataset key must be lower-case letters, numbers and underscores.");
  const name = assertText(input.name, "Dataset name", 1, 120);
  const subjectArea = assertText(input.subjectArea, "Subject area", 1, 80);
  if (!DATASET_REFRESH_CADENCES.includes(input.refreshCadence as (typeof DATASET_REFRESH_CADENCES)[number])) {
    throw new Error("Choose a supported refresh cadence.");
  }
  if (!Number.isInteger(input.expectedLatencyHours) || input.expectedLatencyHours < 1 || input.expectedLatencyHours > 168) {
    throw new Error("Expected latency must be between 1 and 168 hours.");
  }
  if (input.fields.length === 0) throw new Error("Publish at least one governed field.");

  const { rows: [pipeline] } = await client.query(
    `select pipeline.id
       from public.pipelines pipeline
       join public.connectors connector
         on connector.id = pipeline.connector_id and connector.tenant_id = pipeline.tenant_id
      where pipeline.id = $1 and pipeline.tenant_id = $2
        and pipeline.status <> 'disabled' and connector.status <> 'disabled'`,
    [input.pipelineId, input.tenantId],
  );
  if (!pipeline) throw new Error("The pipeline was not found or is disabled.");

  const { rows: [existing] } = await client.query(
    `select id from public.governed_datasets
      where tenant_id = $1 and source_pipeline_id = $2`,
    [input.tenantId, input.pipelineId],
  );
  if (existing) throw new Error("This pipeline already publishes a governed dataset.");

  const seenKeys = new Set<string>();
  const fields = input.fields.map((field) => {
    const fieldKey = field.fieldKey.trim().toLocaleLowerCase("en-GB");
    if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) throw new Error(`Field key '${field.fieldKey}' is not a valid governed key.`);
    if (seenKeys.has(fieldKey)) throw new Error(`Field key '${fieldKey}' is used more than once.`);
    seenKeys.add(fieldKey);
    if (!GOVERNED_DATA_TYPES.includes(field.dataType)) throw new Error(`Field '${fieldKey}' has an unsupported data type.`);
    if (!GOVERNED_FIELD_ROLES.includes(field.fieldRole)) throw new Error(`Field '${fieldKey}' has an unsupported role.`);
    if (field.aggregation !== null && !GOVERNED_AGGREGATIONS.includes(field.aggregation)) {
      throw new Error(`Field '${fieldKey}' has an unsupported aggregation.`);
    }
    return {
      ...field,
      fieldKey,
      sourceField: assertText(field.sourceField, `Source column for '${fieldKey}'`, 1, 200),
      name: assertText(field.name, `Display name for '${fieldKey}'`, 1, 120),
      description: field.description.trim().slice(0, 500),
    };
  });

  const { rows: [dataset] } = await client.query(
    `insert into public.governed_datasets
       (tenant_id, dataset_key, name, description, subject_area, status,
        source_pipeline_id, refresh_cadence, expected_latency, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'published', $6, $7, make_interval(hours => $8), $9, $9)
     returning id`,
    [input.tenantId, datasetKey, name, input.description.trim().slice(0, 500), subjectArea,
      input.pipelineId, input.refreshCadence, input.expectedLatencyHours, input.actorUserId],
  );

  await client.query(
    `insert into public.governed_dataset_fields
       (tenant_id, dataset_id, field_key, source_field, name, description,
        data_type, field_role, aggregation, is_sensitive)
     select $1, $2, item.field_key, item.source_field, item.name, item.description,
            item.data_type, item.field_role, item.aggregation, item.is_sensitive
       from jsonb_to_recordset($3::jsonb) as item(
         field_key text, source_field text, name text, description text,
         data_type text, field_role text, aggregation text, is_sensitive boolean
       )`,
    [input.tenantId, dataset.id, JSON.stringify(fields.map((field) => ({
      field_key: field.fieldKey,
      source_field: field.sourceField,
      name: field.name,
      description: field.description,
      data_type: field.dataType,
      field_role: field.fieldRole,
      aggregation: field.aggregation,
      is_sensitive: field.isSensitive,
    })))],
  );

  return { datasetId: dataset.id, fieldCount: fields.length };
}

/**
 * Changing sensitivity is a governance decision with an immediate data
 * consequence: a field that becomes sensitive is removed from the projection
 * rule and its already-published projections are discarded in the same
 * transaction, so nothing keeps serving a field the tenant just restricted.
 */
export async function updateGovernedFieldGovernance(
  client: PoolClient,
  input: {
    tenantId: string;
    datasetId: string;
    fields: ReadonlyArray<{ fieldKey: string; fieldRole: GovernedFieldRole; isSensitive: boolean }>;
    actorUserId: string;
  },
): Promise<{ changedFields: string[]; withdrawnFields: string[] }> {
  const { rows: current } = await client.query(
    `select field_key, field_role, is_sensitive
       from public.governed_dataset_fields
      where tenant_id = $1 and dataset_id = $2
      for update`,
    [input.tenantId, input.datasetId],
  );
  if (current.length === 0) throw new Error("The dataset was not found or has no governed fields.");
  const currentByKey = new Map(current.map((field) => [field.field_key as string, field]));

  const changedFields: string[] = [];
  const withdrawnFields: string[] = [];
  for (const field of input.fields) {
    const existing = currentByKey.get(field.fieldKey);
    if (!existing) throw new Error(`Field '${field.fieldKey}' is not part of this dataset.`);
    if (!GOVERNED_FIELD_ROLES.includes(field.fieldRole)) throw new Error(`Field '${field.fieldKey}' has an unsupported role.`);
    if (existing.field_role === field.fieldRole && existing.is_sensitive === field.isSensitive) continue;
    changedFields.push(field.fieldKey);
    if (!existing.is_sensitive && field.isSensitive) withdrawnFields.push(field.fieldKey);
    await client.query(
      `update public.governed_dataset_fields
          set field_role = $3, is_sensitive = $4,
              aggregation = case when $3 = 'measure' then coalesce(aggregation, 'sum') else null end
        where tenant_id = $1 and dataset_id = $2 and field_key = $5`,
      [input.tenantId, input.datasetId, field.fieldRole, field.isSensitive, field.fieldKey],
    );
  }

  if (withdrawnFields.length > 0) {
    await client.query(
      `delete from public.governed_record_projections
        where tenant_id = $1 and dataset_id = $2`,
      [input.tenantId, input.datasetId],
    );
    const { rows: [rule] } = await client.query(
      `select id, org_code_field_key, occurred_at_field_key, measure_field_key, projected_field_keys
         from public.governed_record_projection_rules
        where tenant_id = $1 and dataset_id = $2
        for update`,
      [input.tenantId, input.datasetId],
    );
    if (rule) {
      const withdrawn = new Set(withdrawnFields);
      const remaining = (rule.projected_field_keys as string[]).filter((key) => !withdrawn.has(key));
      const ruleBroken = withdrawn.has(rule.org_code_field_key)
        || withdrawn.has(rule.occurred_at_field_key)
        || (rule.measure_field_key !== null && withdrawn.has(rule.measure_field_key))
        || remaining.length === 0;
      if (ruleBroken) {
        await client.query(
          `delete from public.governed_record_projection_rules where tenant_id = $1 and id = $2`,
          [input.tenantId, rule.id],
        );
      } else {
        await client.query(
          `update public.governed_record_projection_rules
              set projected_field_keys = $3::text[], status = 'disabled',
                  last_projected_record_count = 0, last_unmatched_record_count = 0,
                  updated_by = $4, updated_at = now()
            where tenant_id = $1 and id = $2`,
          [input.tenantId, rule.id, remaining, input.actorUserId],
        );
      }
    }
  }

  return { changedFields, withdrawnFields };
}

export async function saveRecordProjectionRule(
  client: PoolClient,
  input: {
    tenantId: string;
    datasetId: string;
    status: "active" | "disabled";
    orgCodeFieldKey: string;
    occurredAtFieldKey: string;
    measureFieldKey: string | null;
    projectedFieldKeys: readonly string[];
    maxRecords: number;
    actorUserId: string;
  },
): Promise<string> {
  const projectedFieldKeys = [...new Set(input.projectedFieldKeys)];
  if (projectedFieldKeys.length === 0) throw new Error("Choose at least one field to project.");
  if (projectedFieldKeys.length > MAX_PROJECTED_FIELDS) {
    throw new Error(`A projection may expose at most ${MAX_PROJECTED_FIELDS} fields.`);
  }
  if (input.measureFieldKey && !projectedFieldKeys.includes(input.measureFieldKey)) {
    throw new Error("The contribution field must also be projected so the drill-through can show it.");
  }
  if (!Number.isInteger(input.maxRecords) || input.maxRecords < 100 || input.maxRecords > 50_000) {
    throw new Error("The projection limit must be between 100 and 50,000 records.");
  }

  const { rows: [dataset] } = await client.query(
    `select id, source_pipeline_id from public.governed_datasets
      where tenant_id = $1 and id = $2 and status = 'published'`,
    [input.tenantId, input.datasetId],
  );
  if (!dataset) throw new Error("Publish the governed dataset before configuring record projection.");
  if (!dataset.source_pipeline_id) throw new Error("Only a dataset published from a Connect pipeline can project records.");

  const { rows: [saved] } = await client.query(
    `insert into public.governed_record_projection_rules
       (tenant_id, dataset_id, status, org_code_field_key, occurred_at_field_key,
        measure_field_key, projected_field_keys, max_records, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $9)
     on conflict (tenant_id, dataset_id) do update
        set status = excluded.status,
            org_code_field_key = excluded.org_code_field_key,
            occurred_at_field_key = excluded.occurred_at_field_key,
            measure_field_key = excluded.measure_field_key,
            projected_field_keys = excluded.projected_field_keys,
            max_records = excluded.max_records,
            updated_by = excluded.updated_by,
            updated_at = now()
     returning id`,
    [input.tenantId, input.datasetId, input.status, input.orgCodeFieldKey, input.occurredAtFieldKey,
      input.measureFieldKey, projectedFieldKeys, input.maxRecords, input.actorUserId],
  );
  if (!saved) throw new Error("The projection rule could not be saved.");
  // Disabling withdraws the data as well as the configuration: a viewer must
  // not keep drilling into records the tenant has just stopped publishing.
  if (input.status === "disabled") {
    await client.query(
      `delete from public.governed_record_projections where tenant_id = $1 and dataset_id = $2`,
      [input.tenantId, input.datasetId],
    );
  }
  return saved.id;
}
