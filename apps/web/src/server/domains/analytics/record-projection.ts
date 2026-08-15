import type { PoolClient } from "@neondatabase/serverless";
import { insertAuditLog } from "../access-control/audit";

/**
 * Turns Connect's operator-only curated records into the governed projections
 * defined in migration 0031, then links each projection to the KPI values it
 * falls inside. Nothing here widens what a reader may see: the projection rows
 * carry only approved non-sensitive fields, and every read of them still goes
 * through the lineage-scoped RLS policy under the viewer's own context.
 */

export interface ProjectionRunResult {
  projectedRecords: number;
  unmatchedRecords: number;
  linkedKpiValues: number;
  lineageLinks: number;
  skippedReasons: Record<string, number>;
}

export interface KpiValueRecordDrill {
  value: {
    id: string;
    kpiName: string;
    kpiDefinition: string;
    unit: string;
    currencyCode: string | null;
    decimalPlaces: number;
    organisationName: string;
    periodStart: string;
    periodEnd: string;
    actualValue: number;
  };
  fields: Array<{ key: string; name: string; dataType: string }>;
  records: Array<{
    projectionId: string;
    occurredAt: string | null;
    contributionValue: number | null;
    sourceRefreshedAt: string;
    values: Record<string, string | number | boolean | null>;
  }>;
  /** How much of the aggregate the returned records actually account for. */
  coverage: {
    linkedRecords: number;
    returnedRecords: number;
    contributionTotal: number | null;
    explainsAggregate: boolean | null;
  };
}

function isPlainScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseOccurredAt(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function countReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

/**
 * Rebuilds the dataset's projections from the current curated records. The
 * rebuild is a delete-and-insert rather than an incremental merge so a record
 * that moved organisation, was deleted at source, or lost a field cannot leave
 * a stale row behind — correctness matters more than churn at these volumes.
 */
export async function projectDatasetRecords(
  client: PoolClient,
  input: { tenantId: string; datasetId: string; actorUserId: string },
): Promise<ProjectionRunResult> {
  const { rows: [rule] } = await client.query(
    `select rule.id, rule.status, rule.org_code_field_key, rule.occurred_at_field_key,
            rule.measure_field_key, rule.projected_field_keys, rule.max_records,
            dataset.source_pipeline_id, dataset.status as dataset_status
       from public.governed_record_projection_rules rule
       join public.governed_datasets dataset
         on dataset.id = rule.dataset_id and dataset.tenant_id = rule.tenant_id
      where rule.tenant_id = $1 and rule.dataset_id = $2
        for update of rule`,
    [input.tenantId, input.datasetId],
  );
  if (!rule) throw new Error("Configure record projection for this dataset first.");
  if (rule.status !== "active") throw new Error("Record projection is disabled for this dataset.");
  if (rule.dataset_status !== "published") throw new Error("The governed dataset is not published.");
  if (!rule.source_pipeline_id) throw new Error("This dataset has no Connect pipeline to project from.");

  const projectedFieldKeys: string[] = rule.projected_field_keys ?? [];
  const neededKeys = [...new Set([
    ...projectedFieldKeys,
    rule.org_code_field_key as string,
    rule.occurred_at_field_key as string,
    ...(rule.measure_field_key ? [rule.measure_field_key as string] : []),
  ])];

  const { rows: fieldRows } = await client.query(
    `select field_key, coalesce(source_field, field_key) as source_key, data_type, is_sensitive
       from public.governed_dataset_fields
      where tenant_id = $1 and dataset_id = $2 and field_key = any($3::text[])`,
    [input.tenantId, input.datasetId, neededKeys],
  );
  if (fieldRows.length !== neededKeys.length) {
    throw new Error("The projection rule references a field that is no longer in the governed catalogue.");
  }
  const sensitive = fieldRows.find((field) => field.is_sensitive);
  if (sensitive) throw new Error(`Field '${sensitive.field_key}' is now sensitive and cannot be projected.`);
  const sourceKeyByField = new Map<string, string>(fieldRows.map((field) => [field.field_key, field.source_key]));

  const { rows: orgRows } = await client.query(
    `select node.id, node.code
       from public.org_nodes node
      where node.tenant_id = $1 and node.code is not null`,
    [input.tenantId],
  );
  const orgNodeByCode = new Map<string, string>(
    orgRows.map((row) => [String(row.code).trim().toLocaleLowerCase("en-GB"), row.id as string]),
  );

  const maxRecords = Number(rule.max_records);
  const { rows: curated } = await client.query(
    `select record.id, record.data, extract(epoch from record.last_seen_at) as last_seen_epoch
       from public.curated_records record
      where record.tenant_id = $1 and record.pipeline_id = $2 and not record.is_deleted
      order by record.last_seen_at desc, record.id
      limit $3`,
    [input.tenantId, rule.source_pipeline_id, maxRecords + 1],
  );
  const truncated = curated.length > maxRecords;
  const considered = truncated ? curated.slice(0, maxRecords) : curated;

  const orgSourceKey = sourceKeyByField.get(rule.org_code_field_key as string)!;
  const occurredSourceKey = sourceKeyByField.get(rule.occurred_at_field_key as string)!;
  const skippedReasons: Record<string, number> = {};
  if (truncated) skippedReasons.record_limit_reached = curated.length - considered.length;

  const projections: Array<{
    source_record_id: string;
    org_node_id: string;
    occurred_at: string;
    display_data: Record<string, string | number | boolean | null>;
    source_refreshed_at: string;
  }> = [];
  for (const record of considered) {
    const data = (record.data ?? {}) as Record<string, unknown>;
    const code = data[orgSourceKey];
    const orgNodeId = typeof code === "string" || typeof code === "number"
      ? orgNodeByCode.get(String(code).trim().toLocaleLowerCase("en-GB"))
      : undefined;
    if (!orgNodeId) {
      countReason(skippedReasons, "no_matching_organisation");
      continue;
    }
    const occurredAt = parseOccurredAt(data[occurredSourceKey]);
    if (!occurredAt) {
      countReason(skippedReasons, "missing_record_date");
      continue;
    }
    const displayData: Record<string, string | number | boolean | null> = {};
    let rejected = false;
    for (const fieldKey of projectedFieldKeys) {
      const raw = data[sourceKeyByField.get(fieldKey)!];
      const value = raw === undefined ? null : raw;
      if (!isPlainScalar(value)) {
        rejected = true;
        break;
      }
      displayData[fieldKey] = value;
    }
    if (rejected) {
      countReason(skippedReasons, "unsupported_field_value");
      continue;
    }
    projections.push({
      source_record_id: record.id,
      org_node_id: orgNodeId,
      occurred_at: occurredAt,
      display_data: displayData,
      source_refreshed_at: new Date(Number(record.last_seen_epoch) * 1_000).toISOString(),
    });
  }

  await client.query(
    `delete from public.governed_record_projections where tenant_id = $1 and dataset_id = $2`,
    [input.tenantId, input.datasetId],
  );

  if (projections.length > 0) {
    await client.query(
      `insert into public.governed_record_projections
         (tenant_id, dataset_id, source_record_id, org_node_id, occurred_at,
          display_data, source_refreshed_at)
       select $1, $2, item.source_record_id, item.org_node_id, item.occurred_at,
              item.display_data, item.source_refreshed_at
         from jsonb_to_recordset($3::jsonb) as item(
           source_record_id uuid, org_node_id uuid, occurred_at timestamptz,
           display_data jsonb, source_refreshed_at timestamptz
         )
       on conflict (tenant_id, dataset_id, source_record_id, org_node_id) do nothing`,
      [input.tenantId, input.datasetId, JSON.stringify(projections)],
    );
  }

  // Lineage is deliberately restricted to unsliced values: a dimension-sliced
  // aggregate would need the slice's own member mapping before these records
  // could honestly be called its contributors.
  const measureFieldKey = rule.measure_field_key as string | null;
  const { rows: lineageRows } = await client.query(
    `insert into public.kpi_value_record_lineage
       (tenant_id, kpi_value_id, projection_id, contribution_value)
     select $1, value.id, projection.id,
            case when $3::text is null then null
                 else (projection.display_data ->> $3::text)::numeric end
       from public.governed_record_projections projection
       join public.kpi_definitions definition
         on definition.tenant_id = projection.tenant_id
        and definition.dataset_id = projection.dataset_id
        and definition.approval_status = 'approved'
       join public.kpi_values value
         on value.tenant_id = projection.tenant_id
        and value.kpi_definition_id = definition.id
        and value.org_node_id = projection.org_node_id
        and value.dimension_slice = '{}'::jsonb
        and projection.occurred_at >= value.period_start
        and projection.occurred_at < value.period_end
      where projection.tenant_id = $1 and projection.dataset_id = $2
     on conflict (tenant_id, kpi_value_id, projection_id) do nothing
     returning kpi_value_id`,
    [input.tenantId, input.datasetId, measureFieldKey],
  );

  await client.query(
    `update public.governed_record_projection_rules
        set last_projected_at = now(),
            last_projected_record_count = $3,
            last_unmatched_record_count = $4,
            updated_by = $5,
            updated_at = now()
      where tenant_id = $1 and dataset_id = $2`,
    [input.tenantId, input.datasetId, projections.length, considered.length - projections.length, input.actorUserId],
  );

  return {
    projectedRecords: projections.length,
    unmatchedRecords: considered.length - projections.length,
    linkedKpiValues: new Set(lineageRows.map((row) => row.kpi_value_id)).size,
    lineageLinks: lineageRows.length,
    skippedReasons,
  };
}

/**
 * PULSE-004 drill-through. The audit event is written on the caller's own
 * transaction before the records are returned, so a read that cannot be
 * recorded does not happen — blueprint 12: privileged reads fail closed if
 * their audit event cannot be recorded.
 */
export async function loadKpiValueRecordDrill(
  client: PoolClient,
  input: {
    tenantId: string;
    valueId: string;
    actorUserId: string;
    limit?: number;
    ipAddress?: string;
    userAgent?: string;
  },
): Promise<KpiValueRecordDrill | null> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const { rows: [value] } = await client.query(
    `select value.id, value.actual_value, value.kpi_definition_id,
            value.period_start::text as period_start,
            value.period_end::text as period_end,
            definition.name as kpi_name, definition.definition as kpi_definition,
            definition.dataset_id, definition.unit, definition.currency_code,
            definition.decimal_places, version.name as organisation_name
       from public.kpi_values value
       join public.kpi_definitions definition
         on definition.id = value.kpi_definition_id and definition.tenant_id = value.tenant_id
       join public.org_node_versions version
         on version.org_node_id = value.org_node_id and version.tenant_id = value.tenant_id
        and version.valid_from <= current_date
        and (version.valid_to is null or version.valid_to > current_date)
      where value.tenant_id = $1 and value.id = $2
        and definition.approval_status = 'approved'`,
    [input.tenantId, input.valueId],
  );
  if (!value) return null;

  const { rows: [totals] } = await client.query(
    `select count(*)::integer as linked_records,
            sum(lineage.contribution_value) as contribution_total
       from public.kpi_value_record_lineage lineage
      where lineage.tenant_id = $1 and lineage.kpi_value_id = $2`,
    [input.tenantId, input.valueId],
  );
  const linkedRecords = Number(totals?.linked_records ?? 0);

  const { rows: recordRows } = linkedRecords === 0 ? { rows: [] } : await client.query(
    `select projection.id, projection.display_data,
            extract(epoch from projection.occurred_at) as occurred_epoch,
            extract(epoch from projection.source_refreshed_at) as refreshed_epoch,
            lineage.contribution_value
       from public.kpi_value_record_lineage lineage
       join public.governed_record_projections projection
         on projection.id = lineage.projection_id and projection.tenant_id = lineage.tenant_id
      where lineage.tenant_id = $1 and lineage.kpi_value_id = $2
      order by projection.occurred_at desc nulls last, projection.id
      limit $3`,
    [input.tenantId, input.valueId, limit],
  );

  const { rows: fieldRows } = await client.query(
    `select field_key, name, data_type
       from public.governed_dataset_fields
      where tenant_id = $1 and dataset_id = $2 and not is_sensitive
      order by field_key`,
    [input.tenantId, value.dataset_id],
  );
  const fieldNameByKey = new Map(fieldRows.map((field) => [field.field_key as string, field]));
  const presentKeys = new Set<string>();
  for (const row of recordRows) {
    for (const key of Object.keys((row.display_data ?? {}) as Record<string, unknown>)) presentKeys.add(key);
  }

  await insertAuditLog(client, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: "pulse.record_drill_through",
    targetType: "kpi_value",
    targetId: input.valueId,
    metadata: {
      kpi_definition_id: value.kpi_definition_id,
      dataset_id: value.dataset_id,
      linked_records: linkedRecords,
      returned_records: recordRows.length,
    },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  const contributionTotal = totals?.contribution_total === null || totals?.contribution_total === undefined
    ? null
    : Number(totals.contribution_total);
  const actualValue = Number(value.actual_value);

  return {
    value: {
      id: value.id,
      kpiName: value.kpi_name,
      kpiDefinition: value.kpi_definition,
      unit: value.unit,
      currencyCode: value.currency_code ?? null,
      decimalPlaces: Number(value.decimal_places),
      organisationName: value.organisation_name,
      periodStart: String(value.period_start),
      periodEnd: String(value.period_end),
      actualValue,
    },
    fields: [...presentKeys]
      .sort()
      .map((key) => ({
        key,
        name: fieldNameByKey.get(key)?.name ?? key,
        dataType: fieldNameByKey.get(key)?.data_type ?? "text",
      })),
    records: recordRows.map((row) => ({
      projectionId: row.id,
      occurredAt: row.occurred_epoch === null
        ? null
        : new Date(Number(row.occurred_epoch) * 1_000).toISOString(),
      contributionValue: row.contribution_value === null ? null : Number(row.contribution_value),
      sourceRefreshedAt: new Date(Number(row.refreshed_epoch) * 1_000).toISOString(),
      values: (row.display_data ?? {}) as Record<string, string | number | boolean | null>,
    })),
    coverage: {
      linkedRecords,
      returnedRecords: recordRows.length,
      contributionTotal,
      explainsAggregate: contributionTotal === null
        ? null
        : Math.abs(contributionTotal - actualValue) < Math.max(Math.abs(actualValue) * 1e-6, 1e-6),
    },
  };
}
