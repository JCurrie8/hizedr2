"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { isAppRole } from "@/server/domains/access-control/membership-access";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import {
  approveKpiDraft,
  createKpiDraft,
  createNextKpiVersion,
  KPI_AGGREGATIONS,
  KPI_NODE_TYPES,
  KPI_TARGET_METHODS,
  rejectKpiDraft,
  updateKpiDraft,
  type KpiDraftInput,
} from "@/server/domains/pulse/kpi-governance";
import type { KpiDirection, KpiUnit } from "@/server/domains/pulse/kpis";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KPI_UNITS: KpiUnit[] = ["number", "percentage", "currency", "duration", "score"];
const KPI_DIRECTIONS: KpiDirection[] = ["higher", "lower", "target"];

async function requireKpiGovernor(companyAdminOnly = false) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (companyAdminOnly ? ctx.role !== "company_admin" : ctx.role !== "company_admin" && ctx.role !== "analyst") {
    throw new Error(companyAdminOnly ? "Only a Company Admin can review KPI definitions." : "Only a Company Admin or Analyst can configure KPIs.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" }),
  );
  return ctx;
}

function requiredText(formData: FormData, name: string, label: string, max: number): string {
  const value = String(formData.get(name) ?? "").trim();
  if (!value || value.length > max) throw new Error(`${label} is required and must be ${max} characters or fewer.`);
  return value;
}

function parseStringList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseDraftForm(formData: FormData) {
  const datasetId = String(formData.get("datasetId") ?? "");
  if (!UUID_PATTERN.test(datasetId)) throw new Error("Choose a governed dataset.");
  const key = requiredText(formData, "key", "KPI key", 80);
  if (!KEY_PATTERN.test(key)) throw new Error("KPI key must use lowercase letters, numbers and underscores.");
  const unit = String(formData.get("unit") ?? "") as KpiUnit;
  if (!KPI_UNITS.includes(unit)) throw new Error("Choose a valid unit.");
  const currencyCodeValue = String(formData.get("currencyCode") ?? "").trim().toUpperCase();
  const currencyCode = unit === "currency" ? currencyCodeValue : null;
  if (unit === "currency" && !/^[A-Z]{3}$/.test(currencyCodeValue)) throw new Error("Currency KPIs require a three-letter currency code.");
  const decimalPlaces = Number(formData.get("decimalPlaces") ?? 0);
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new Error("Decimal places must be between 0 and 6.");
  const favourableDirection = String(formData.get("favourableDirection") ?? "") as KpiDirection;
  if (!KPI_DIRECTIONS.includes(favourableDirection)) throw new Error("Choose a favourable direction.");
  const aggregation = String(formData.get("aggregation") ?? "") as KpiDraftInput["aggregation"];
  if (!KPI_AGGREGATIONS.includes(aggregation)) throw new Error("Choose a valid aggregation.");
  const targetMethod = String(formData.get("targetMethod") ?? "") as KpiDraftInput["targetMethod"];
  if (!KPI_TARGET_METHODS.includes(targetMethod)) throw new Error("Choose a valid target method.");
  const validFrom = String(formData.get("validFrom") ?? "");
  if (!DATE_PATTERN.test(validFrom)) throw new Error("Choose a valid effective date.");
  const applicableNodeTypes = formData.getAll("applicableNodeTypes").map(String)
    .filter((value): value is KpiDraftInput["applicableNodeTypes"][number] => KPI_NODE_TYPES.includes(value as never));
  if (applicableNodeTypes.length === 0) throw new Error("Choose at least one organisation level.");
  const audienceRoles = formData.getAll("audienceRoles").map(String).filter(isAppRole);
  if (audienceRoles.length === 0) throw new Error("Choose at least one audience role.");
  let thresholds: Record<string, unknown> = {};
  const thresholdsJson = String(formData.get("thresholds") ?? "{}").trim() || "{}";
  try {
    const parsed: unknown = JSON.parse(thresholdsJson);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    thresholds = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Threshold rules must be a JSON object.");
  }

  return {
    datasetId,
    key,
    name: requiredText(formData, "name", "Name", 120),
    definition: requiredText(formData, "definition", "Definition", 1200),
    businessPurpose: requiredText(formData, "businessPurpose", "Business purpose", 1200),
    formulaReference: requiredText(formData, "formulaReference", "Formula reference", 500),
    ownerName: requiredText(formData, "ownerName", "Owner", 120),
    reviewerName: requiredText(formData, "reviewerName", "Reviewer", 120),
    unit,
    currencyCode,
    decimalPlaces,
    favourableDirection,
    aggregation,
    refreshCadence: requiredText(formData, "refreshCadence", "Refresh cadence", 120),
    thresholds,
    targetMethod,
    permittedDimensions: parseStringList(formData.get("permittedDimensions")),
    applicableNodeTypes,
    audienceRoles,
    validFrom,
  };
}

export async function createKpiDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireKpiGovernor();
  const input = parseDraftForm(formData);
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createKpiDraft(client, { ...input, tenantId: ctx.tenant.id, createdBy: ctx.profileId });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "kpi.draft_created",
      targetType: "kpi_definition",
      targetId: created.id,
      metadata: { key: input.key, version: created.version, datasetId: input.datasetId },
    });
  });
  revalidatePath("/admin/kpis");
}

export async function updateKpiDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireKpiGovernor();
  const definitionId = String(formData.get("definitionId") ?? "");
  if (!UUID_PATTERN.test(definitionId)) throw new Error("Choose a valid KPI draft.");
  const input = parseDraftForm(formData);
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await updateKpiDraft(client, { ...input, tenantId: ctx.tenant.id, definitionId });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "kpi.draft_updated",
      targetType: "kpi_definition",
      targetId: definitionId,
      metadata: { datasetId: input.datasetId },
    });
  });
  revalidatePath("/admin/kpis");
}

export async function approveKpiDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireKpiGovernor(true);
  const definitionId = String(formData.get("definitionId") ?? "");
  if (!UUID_PATTERN.test(definitionId)) throw new Error("Choose a valid KPI draft.");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await approveKpiDraft(client, { tenantId: ctx.tenant.id, definitionId });
    await insertAuditLog(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: "kpi.approved", targetType: "kpi_definition", targetId: definitionId });
  });
  revalidatePath("/admin/kpis");
  revalidatePath("/dashboard");
}

export async function rejectKpiDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireKpiGovernor(true);
  const definitionId = String(formData.get("definitionId") ?? "");
  if (!UUID_PATTERN.test(definitionId)) throw new Error("Choose a valid KPI draft.");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await rejectKpiDraft(client, { tenantId: ctx.tenant.id, definitionId });
    await insertAuditLog(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: "kpi.rejected", targetType: "kpi_definition", targetId: definitionId });
  });
  revalidatePath("/admin/kpis");
}

export async function createNextKpiVersionAction(formData: FormData): Promise<void> {
  const ctx = await requireKpiGovernor();
  const definitionId = String(formData.get("definitionId") ?? "");
  const validFrom = String(formData.get("validFrom") ?? "");
  if (!UUID_PATTERN.test(definitionId) || !DATE_PATTERN.test(validFrom)) throw new Error("Choose a KPI and effective date.");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createNextKpiVersion(client, { tenantId: ctx.tenant.id, definitionId, validFrom, createdBy: ctx.profileId });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "kpi.version_drafted",
      targetType: "kpi_definition",
      targetId: created.id,
      metadata: { sourceDefinitionId: definitionId, version: created.version, validFrom },
    });
  });
  revalidatePath("/admin/kpis");
}
