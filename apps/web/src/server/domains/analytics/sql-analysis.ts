import { createHash } from "node:crypto";
import type { AppRole } from "@hized/contracts";
import type { PoolClient } from "@neondatabase/serverless";
import type { SqlAnalysisExecution, SqlAnalysisSourceRow } from "../connectors/sql-server-api";
import { approveKpiDraft, createKpiDraft, type KpiAggregation } from "../pulse/kpi-governance";
import type { KpiDirection, KpiUnit } from "../pulse/kpis";

export interface SqlAnalysisSummary {
  id: string;
  connectorId: string;
  connectorName: string;
  name: string;
  description: string;
  status: "draft" | "validated" | "certified" | "retired";
  lastRunStatus: "succeeded" | "failed" | null;
  lastRunMessage: string | null;
  lastRowCount: number | null;
  lastRunAt: string | null;
  series: Array<{ key: string; label: string; rowCount: number; certifiedKpiId: string | null }>;
}

export interface SqlAnalysisOption {
  id: string;
  name: string;
  status: "validated" | "certified";
  series: Array<{ key: string; label: string; rowCount: number }>;
}

export function sqlAnalysisHash(sqlText: string): string {
  return createHash("sha256").update(sqlText.trim()).digest("hex");
}

export async function createSqlAnalysisDraft(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; name: string; description: string; sqlText: string; actorUserId: string },
): Promise<string> {
  const { rows: [created] } = await client.query(
    `insert into public.sql_analysis_queries
       (tenant_id, connector_id, name, description, sql_text, query_hash, created_by, updated_by)
     select $1, connector.id, $3, $4, $5, $6, $7, $7
       from public.connectors connector
      where connector.tenant_id = $1 and connector.id = $2
        and connector.connector_type in ('sql_server', 'azure_sql')
        and coalesce(connector.config ->> 'direction', 'source') = 'source'
        and connector.status in ('active', 'error')
     returning id`,
    [input.tenantId, input.connectorId, input.name, input.description, input.sqlText, sqlAnalysisHash(input.sqlText), input.actorUserId],
  );
  if (!created) throw new Error("Choose an active read-only SQL connection.");
  return created.id;
}

export async function getSqlAnalysisExecutionContext(
  client: PoolClient,
  input: { tenantId: string; queryId: string },
): Promise<{ connectorId: string; sqlText: string; queryHash: string }> {
  const { rows: [row] } = await client.query(
    `select connector_id, sql_text, query_hash
       from public.sql_analysis_queries
      where tenant_id = $1 and id = $2 and status <> 'retired'`,
    [input.tenantId, input.queryId],
  );
  if (!row) throw new Error("The SQL analysis was not found.");
  return { connectorId: row.connector_id, sqlText: row.sql_text, queryHash: row.query_hash };
}

interface ResolvedAnalysisRow extends SqlAnalysisSourceRow { orgNodeId: string; categoryLabel: string }

async function resolveOrganisationRows(
  client: PoolClient,
  tenantId: string,
  rows: SqlAnalysisSourceRow[],
): Promise<ResolvedAnalysisRow[]> {
  const requestedIds = [...new Set(rows.flatMap((row) => row.orgNodeId ? [row.orgNodeId] : []))];
  const requestedCodes = [...new Set(rows.flatMap((row) => row.orgCode ? [row.orgCode.toLocaleLowerCase("en-GB")] : []))];
  const { rows: nodes } = await client.query(
    `select node.id, lower(node.code) as code, version.name
       from public.org_nodes node
       join public.org_node_versions version
         on version.org_node_id = node.id and version.tenant_id = node.tenant_id
        and version.valid_from <= current_date
        and (version.valid_to is null or version.valid_to > current_date)
      where node.tenant_id = $1
        and (node.id = any($2::uuid[]) or lower(node.code) = any($3::text[]))`,
    [tenantId, requestedIds, requestedCodes],
  );
  const byId = new Map<string, { id: string; name: string }>();
  const byCode = new Map<string, Array<{ id: string; name: string }>>();
  for (const node of nodes) {
    byId.set(node.id, { id: node.id, name: node.name });
    if (node.code) byCode.set(node.code, [...(byCode.get(node.code) ?? []), { id: node.id, name: node.name }]);
  }
  return rows.map((row, index) => {
    const byExactId = row.orgNodeId ? byId.get(row.orgNodeId) : null;
    const codeMatches = row.orgCode ? byCode.get(row.orgCode.toLocaleLowerCase("en-GB")) ?? [] : [];
    if (row.orgNodeId && !byExactId) throw new Error(`Row ${index + 1} has an org_node_id outside this tenant.`);
    if (!byExactId && codeMatches.length !== 1) {
      throw new Error(codeMatches.length > 1
        ? `Row ${index + 1} org_code matches more than one organisation node.`
        : `Row ${index + 1} org_code does not match a current organisation node.`);
    }
    const node = byExactId ?? codeMatches[0];
    return { ...row, orgNodeId: node.id, categoryLabel: row.categoryLabel || node.name };
  });
}

async function refreshCertifiedValues(client: PoolClient, input: { tenantId: string; queryId: string; actorUserId: string }): Promise<void> {
  const { rows: certifications } = await client.query(
    `select certification.kpi_definition_id, certification.series_key
       from public.sql_analysis_certifications certification
       join public.sql_analysis_queries query_row
         on query_row.id = certification.query_id and query_row.tenant_id = certification.tenant_id
      where certification.tenant_id = $1 and certification.query_id = $2
        and certification.query_hash = query_row.query_hash`,
    [input.tenantId, input.queryId],
  );
  for (const certification of certifications) {
    await client.query(
      `delete from public.kpi_values
        where tenant_id = $1 and kpi_definition_id = $2 and dimension_slice = '{}'::jsonb`,
      [input.tenantId, certification.kpi_definition_id],
    );
    await client.query(
      `insert into public.kpi_values
         (tenant_id, kpi_definition_id, org_node_id, period_start, period_end,
          actual_value, target_value, prior_period_value, numerator_value,
          denominator_value, source_refreshed_at, calculated_by)
       select row.tenant_id, $3, row.org_node_id, row.period_start, row.period_end,
              row.actual_value, row.target_value, row.prior_period_value,
              row.numerator_value, row.denominator_value, row.source_refreshed_at, $4
         from public.sql_analysis_rows row
        where row.tenant_id = $1 and row.query_id = $2 and row.series_key = $5`,
      [input.tenantId, input.queryId, certification.kpi_definition_id, input.actorUserId, certification.series_key],
    );
  }
}

export async function saveSqlAnalysisExecution(
  client: PoolClient,
  input: { tenantId: string; queryId: string; actorUserId: string; execution: SqlAnalysisExecution },
): Promise<void> {
  const rows = await resolveOrganisationRows(client, input.tenantId, input.execution.rows);
  const duplicate = new Set<string>();
  for (const row of rows) {
    const key = `${row.seriesKey}:${row.orgNodeId}:${row.periodStart}:${row.periodEnd}`;
    if (duplicate.has(key)) throw new Error("Each series can return only one row per organisation node and reporting period.");
    duplicate.add(key);
  }
  await client.query("delete from public.sql_analysis_rows where tenant_id = $1 and query_id = $2", [input.tenantId, input.queryId]);
  if (rows.length > 0) {
    const payload = rows.map((row, rowIndex) => ({ ...row, rowIndex }));
    await client.query(
      `insert into public.sql_analysis_rows
         (tenant_id, query_id, row_index, org_node_id, series_key, series_label,
          category_label, period_start, period_end, actual_value, target_value,
          prior_period_value, numerator_value, denominator_value, source_refreshed_at)
       select $1, $2, item.row_index, item.org_node_id, item.series_key, item.series_label,
              item.category_label, item.period_start, item.period_end, item.actual_value,
              item.target_value, item.prior_period_value, item.numerator_value,
              item.denominator_value, item.source_refreshed_at
         from jsonb_to_recordset($3::jsonb) as item(
           row_index integer, org_node_id uuid, series_key text, series_label text,
           category_label text, period_start date, period_end date, actual_value numeric,
           target_value numeric, prior_period_value numeric, numerator_value numeric,
           denominator_value numeric, source_refreshed_at timestamptz
         )`,
      [input.tenantId, input.queryId, JSON.stringify(payload.map((row) => ({
        row_index: row.rowIndex, org_node_id: row.orgNodeId, series_key: row.seriesKey,
        series_label: row.seriesLabel, category_label: row.categoryLabel,
        period_start: row.periodStart, period_end: row.periodEnd, actual_value: row.actualValue,
        target_value: row.targetValue, prior_period_value: row.priorPeriodValue,
        numerator_value: row.numeratorValue, denominator_value: row.denominatorValue,
        source_refreshed_at: row.sourceRefreshedAt,
      })))],
    );
  }
  const refreshedAt = rows.reduce<string | null>((latest, row) => !latest || row.sourceRefreshedAt > latest ? row.sourceRefreshedAt : latest, null);
  await client.query(
    `update public.sql_analysis_queries query_row
        set status = case when exists (
              select 1 from public.sql_analysis_rows result
               where result.tenant_id = query_row.tenant_id and result.query_id = query_row.id
            ) and not exists (
              select 1 from public.sql_analysis_rows result
               where result.tenant_id = query_row.tenant_id and result.query_id = query_row.id
                 and not exists (
                   select 1 from public.sql_analysis_certifications certification
                    where certification.tenant_id = result.tenant_id
                      and certification.query_id = result.query_id
                      and certification.series_key = result.series_key
                      and certification.query_hash = query_row.query_hash
                 )
            ) then 'certified' else 'validated' end,
            result_signature = $3::jsonb, last_run_status = 'succeeded',
            last_run_message = 'Bounded SQL analysis completed', last_row_count = $4,
            last_run_at = now(), source_refreshed_at = $5, updated_by = $6, updated_at = now()
      where query_row.tenant_id = $1 and query_row.id = $2`,
    [input.tenantId, input.queryId, JSON.stringify(input.execution.signature), rows.length, refreshedAt, input.actorUserId],
  );
  await refreshCertifiedValues(client, input);
}

export async function recordSqlAnalysisFailure(
  client: PoolClient,
  input: { tenantId: string; queryId: string; actorUserId: string; message: string },
): Promise<void> {
  await client.query(
    `update public.sql_analysis_queries
        set last_run_status = 'failed', last_run_message = $3, last_run_at = now(),
            updated_by = $4, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [input.tenantId, input.queryId, input.message.slice(0, 500), input.actorUserId],
  );
}

export async function listSqlAnalyses(client: PoolClient, input: { tenantId: string }): Promise<SqlAnalysisSummary[]> {
  const { rows } = await client.query(
    `select query_row.id, query_row.connector_id, connector.name as connector_name,
            query_row.name, query_row.description, query_row.status,
            query_row.last_run_status, query_row.last_run_message, query_row.last_row_count,
            extract(epoch from query_row.last_run_at) as last_run_epoch,
            coalesce(jsonb_agg(distinct jsonb_build_object(
              'key', result.series_key, 'label', result.series_label,
              'rowCount', result.row_count, 'certifiedKpiId', certification.kpi_definition_id
            )) filter (where result.series_key is not null), '[]'::jsonb) as series
       from public.sql_analysis_queries query_row
       join public.connectors connector
         on connector.id = query_row.connector_id and connector.tenant_id = query_row.tenant_id
       left join (
         select tenant_id, query_id, series_key, min(series_label) as series_label, count(*)::integer as row_count
           from public.sql_analysis_rows group by tenant_id, query_id, series_key
       ) result on result.tenant_id = query_row.tenant_id and result.query_id = query_row.id
       left join public.sql_analysis_certifications certification
         on certification.tenant_id = query_row.tenant_id
        and certification.query_id = query_row.id and certification.series_key = result.series_key
        and certification.query_hash = query_row.query_hash
      where query_row.tenant_id = $1 and query_row.status <> 'retired'
      group by query_row.id, connector.name
      order by query_row.updated_at desc`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id, connectorId: row.connector_id, connectorName: row.connector_name,
    name: row.name, description: row.description, status: row.status,
    lastRunStatus: row.last_run_status, lastRunMessage: row.last_run_message,
    lastRowCount: row.last_row_count === null ? null : Number(row.last_row_count),
    lastRunAt: row.last_run_epoch === null ? null : new Date(Number(row.last_run_epoch) * 1_000).toISOString(),
    series: (row.series ?? []).map((series: Record<string, unknown>) => ({
      key: String(series.key), label: String(series.label), rowCount: Number(series.rowCount),
      certifiedKpiId: series.certifiedKpiId ? String(series.certifiedKpiId) : null,
    })),
  }));
}

export async function listSqlAnalysisOptions(client: PoolClient, input: { tenantId: string }): Promise<SqlAnalysisOption[]> {
  return (await listSqlAnalyses(client, input))
    .filter((query): query is SqlAnalysisSummary & { status: "validated" | "certified" } => query.status === "validated" || query.status === "certified")
    .map(({ id, name, status, series }) => ({ id, name, status, series: series.map(({ key, label, rowCount }) => ({ key, label, rowCount })) }));
}

export async function certifySqlAnalysisSeries(
  client: PoolClient,
  input: {
    tenantId: string; queryId: string; seriesKey: string; kpiKey: string; name: string;
    definition: string; businessPurpose: string; ownerName: string; unit: KpiUnit;
    currencyCode: string | null; decimalPlaces: number; favourableDirection: KpiDirection;
    aggregation: KpiAggregation; audienceRoles: AppRole[]; actorUserId: string;
  },
): Promise<{ datasetId: string; kpiDefinitionId: string }> {
  const { rows: [query] } = await client.query(
    `select id, name, description, query_hash, source_refreshed_at
       from public.sql_analysis_queries
      where tenant_id = $1 and id = $2 and status in ('validated', 'certified') for update`,
    [input.tenantId, input.queryId],
  );
  if (!query) throw new Error("Run and validate the SQL analysis before certification.");
  const { rows: [series] } = await client.query(
    `select min(series_label) as label, count(*)::integer as row_count,
            count(*) = count(distinct (org_node_id, period_start, period_end)) as unique_grain,
            min(period_start)::text as valid_from
       from public.sql_analysis_rows
      where tenant_id = $1 and query_id = $2 and series_key = $3`,
    [input.tenantId, input.queryId, input.seriesKey],
  );
  if (!series || Number(series.row_count) === 0) throw new Error("Choose a returned SQL series.");
  if (!series.unique_grain) throw new Error("Certified metrics require one value per organisation node and reporting period.");
  const datasetKey = `sql_${input.queryId.replaceAll("-", "").slice(0, 24)}`;
  const { rows: [dataset] } = await client.query(
    `insert into public.governed_datasets
       (tenant_id, dataset_key, name, description, subject_area, status,
        refresh_cadence, expected_latency, last_refreshed_at, created_by, updated_by)
     values ($1, $2, $3, $4, 'SQL analysis', 'published', 'On query refresh',
             interval '1 day', $5, $6, $6)
     on conflict (tenant_id, dataset_key) do update
       set last_refreshed_at = excluded.last_refreshed_at,
           updated_by = excluded.updated_by, updated_at = now()
     returning id`,
    [input.tenantId, datasetKey, query.name, query.description, query.source_refreshed_at, input.actorUserId],
  );
  await client.query(
    `insert into public.governed_dataset_fields
       (tenant_id, dataset_id, field_key, name, description, data_type, field_role, aggregation)
     values
       ($1, $2, 'org_node_id', 'Organisation node', 'Resolved Hized organisation scope.', 'text', 'dimension', null),
       ($1, $2, 'period_start', 'Period start', 'Inclusive reporting-period start.', 'date', 'time', null),
       ($1, $2, 'period_end', 'Period end', 'Exclusive reporting-period end.', 'date', 'time', null),
       ($1, $2, 'actual_value', 'Actual value', 'Numeric SQL result approved for this metric.', 'decimal', 'measure', $3)
     on conflict (tenant_id, dataset_id, field_key) do nothing`,
    [input.tenantId, dataset.id, input.aggregation],
  );
  const draft = await createKpiDraft(client, {
    tenantId: input.tenantId, datasetId: dataset.id, key: input.kpiKey, name: input.name,
    definition: input.definition, businessPurpose: input.businessPurpose,
    formulaReference: `sql-analysis:${input.queryId}:${input.seriesKey}:${query.query_hash}`,
    ownerName: input.ownerName, reviewerName: input.ownerName, unit: input.unit,
    currencyCode: input.currencyCode, decimalPlaces: input.decimalPlaces,
    favourableDirection: input.favourableDirection, aggregation: input.aggregation,
    refreshCadence: "On SQL analysis refresh", thresholds: {}, targetMethod: "period_specific",
    permittedDimensions: [],
    applicableNodeTypes: ["company", "division", "function", "department", "region", "site", "team", "employee"],
    audienceRoles: input.audienceRoles, validFrom: series.valid_from, createdBy: input.actorUserId,
  });
  await approveKpiDraft(client, { tenantId: input.tenantId, definitionId: draft.id });
  await client.query(
    `insert into public.sql_analysis_certifications
       (tenant_id, query_id, series_key, query_hash, dataset_id, kpi_definition_id, row_count, certified_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.tenantId, input.queryId, input.seriesKey, query.query_hash, dataset.id, draft.id, Number(series.row_count), input.actorUserId],
  );
  await client.query(
    `update public.sql_analysis_queries query_row
        set status = case when not exists (
              select 1 from public.sql_analysis_rows result
               where result.tenant_id = query_row.tenant_id and result.query_id = query_row.id
                 and not exists (
                   select 1 from public.sql_analysis_certifications certification
                    where certification.tenant_id = result.tenant_id
                      and certification.query_id = result.query_id
                      and certification.series_key = result.series_key
                      and certification.query_hash = query_row.query_hash
                 )
            ) then 'certified' else 'validated' end,
            updated_by = $3, updated_at = now()
      where query_row.tenant_id = $1 and query_row.id = $2`,
    [input.tenantId, input.queryId, input.actorUserId],
  );
  await refreshCertifiedValues(client, input);
  return { datasetId: dataset.id, kpiDefinitionId: draft.id };
}
