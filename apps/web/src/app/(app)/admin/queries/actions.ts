"use server";

import { withUserContext } from "@hized/db";
import type { AppRole } from "@hized/contracts";
import { revalidatePath } from "next/cache";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import {
  certifySqlAnalysisSeries,
  createSqlAnalysisDraft,
  getSqlAnalysisExecutionContext,
  recordSqlAnalysisFailure,
  saveSqlAnalysisExecution,
} from "@/server/domains/analytics/sql-analysis";
import { executeSqlAnalysisQuery, validateSqlAnalysisText } from "@/server/domains/connectors/sql-server-api";
import { getSqlServerCredentials } from "@/server/domains/connectors/sql-server-connectors";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import { APP_ROLES } from "@/server/domains/access-control/membership-access";
import { KPI_AGGREGATIONS, type KpiAggregation } from "@/server/domains/pulse/kpi-governance";
import type { KpiDirection, KpiUnit } from "@/server/domains/pulse/kpis";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const KPI_UNITS: KpiUnit[] = ["number", "percentage", "currency", "duration", "score"];
const KPI_DIRECTIONS: KpiDirection[] = ["higher", "lower", "target"];

async function requireSqlAnalysisOperator(companyAdminOnly = false) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (companyAdminOnly ? ctx.role !== "company_admin" : !["company_admin", "analyst"].includes(ctx.role)) {
    throw new Error(companyAdminOnly ? "Only a Company Admin can certify Pulse metrics." : "Only a Company Admin or Analyst can author SQL analyses.");
  }
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" });
  });
  return ctx;
}

function requiredText(formData: FormData, key: string, label: string, max: number): string {
  const value = String(formData.get(key) ?? "").trim();
  if (!value || value.length > max) throw new Error(`${label} is required and must be ${max} characters or fewer.`);
  return value;
}

async function runSavedAnalysis(ctx: Awaited<ReturnType<typeof requireSqlAnalysisOperator>>, queryId: string) {
  const context = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getSqlAnalysisExecutionContext(client, { tenantId: ctx.tenant.id, queryId }),
  );
  const stored = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getSqlServerCredentials(client, { tenantId: ctx.tenant.id, connectorId: context.connectorId }),
  );
  try {
    const execution = await executeSqlAnalysisQuery(stored.credentials, context.sqlText);
    await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
      await saveSqlAnalysisExecution(client, { tenantId: ctx.tenant.id, queryId, actorUserId: ctx.profileId, execution });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: "analytics.sql_query_run",
        targetType: "sql_analysis_query", targetId: queryId,
        metadata: { connectorId: context.connectorId, rowCount: execution.rows.length, queryHash: context.queryHash },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SQL analysis failed.";
    await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => recordSqlAnalysisFailure(client, { tenantId: ctx.tenant.id, queryId, actorUserId: ctx.profileId, message }),
    ).catch(() => {});
    throw error;
  }
}

export async function createSqlAnalysisAction(formData: FormData): Promise<void> {
  const ctx = await requireSqlAnalysisOperator();
  const connectorId = String(formData.get("connectorId") ?? "");
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Choose a read-only SQL connection.");
  const name = requiredText(formData, "name", "Analysis name", 120);
  const description = String(formData.get("description") ?? "").trim();
  if (description.length > 1000) throw new Error("Description must be 1,000 characters or fewer.");
  const sqlText = validateSqlAnalysisText(requiredText(formData, "sqlText", "SQL query", 50_000));
  const queryId = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const createdId = await createSqlAnalysisDraft(client, {
      tenantId: ctx.tenant.id, connectorId, name, description, sqlText, actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: "analytics.sql_query_created",
      targetType: "sql_analysis_query", targetId: createdId, metadata: { connectorId, name },
    });
    return createdId;
  });
  await runSavedAnalysis(ctx, queryId);
  revalidatePath("/admin/queries");
}

export async function runSqlAnalysisAction(formData: FormData): Promise<void> {
  const ctx = await requireSqlAnalysisOperator();
  const queryId = String(formData.get("queryId") ?? "");
  if (!UUID_PATTERN.test(queryId)) throw new Error("Choose a valid SQL analysis.");
  await runSavedAnalysis(ctx, queryId);
  revalidatePath("/admin/queries");
  revalidatePath("/canvas");
  revalidatePath("/dashboard");
}

export async function certifySqlAnalysisAction(formData: FormData): Promise<void> {
  const ctx = await requireSqlAnalysisOperator(true);
  const queryId = String(formData.get("queryId") ?? "");
  if (!UUID_PATTERN.test(queryId)) throw new Error("Choose a valid SQL analysis.");
  const seriesKey = requiredText(formData, "seriesKey", "Series", 80);
  const kpiKey = requiredText(formData, "kpiKey", "Metric key", 80);
  if (!KEY_PATTERN.test(seriesKey) || !KEY_PATTERN.test(kpiKey)) throw new Error("Series and metric keys use lowercase letters, numbers and underscores.");
  const unit = String(formData.get("unit") ?? "number") as KpiUnit;
  const favourableDirection = String(formData.get("favourableDirection") ?? "higher") as KpiDirection;
  const aggregation = String(formData.get("aggregation") ?? "sum") as KpiAggregation;
  if (!KPI_UNITS.includes(unit) || !KPI_DIRECTIONS.includes(favourableDirection) || !KPI_AGGREGATIONS.includes(aggregation)) {
    throw new Error("Choose valid metric semantics.");
  }
  const currencyCode = unit === "currency" ? requiredText(formData, "currencyCode", "Currency code", 3).toUpperCase() : null;
  if (currencyCode && !/^[A-Z]{3}$/.test(currencyCode)) throw new Error("Currency code must be three letters.");
  const decimalPlaces = Number(formData.get("decimalPlaces") ?? 0);
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new Error("Decimal places must be between 0 and 6.");
  const audienceRoles = [...new Set(formData.getAll("audienceRoles").map(String))]
    .filter((role): role is AppRole => APP_ROLES.includes(role as AppRole));
  if (audienceRoles.length === 0) throw new Error("Choose at least one audience role.");
  const result = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const certified = await certifySqlAnalysisSeries(client, {
      tenantId: ctx.tenant.id, queryId, seriesKey, kpiKey,
      name: requiredText(formData, "metricName", "Metric name", 120),
      definition: requiredText(formData, "definition", "Definition", 1200),
      businessPurpose: requiredText(formData, "businessPurpose", "Business purpose", 1200),
      ownerName: requiredText(formData, "ownerName", "Owner", 120), unit, currencyCode,
      decimalPlaces, favourableDirection, aggregation, audienceRoles, actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: "pulse.sql_metric_certified",
      targetType: "kpi_definition", targetId: certified.kpiDefinitionId,
      metadata: { queryId, seriesKey, datasetId: certified.datasetId, kpiKey },
    });
    return certified;
  });
  void result;
  revalidatePath("/admin/queries");
  revalidatePath("/admin/kpis");
  revalidatePath("/dashboard");
}
