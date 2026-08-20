"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import {
  DATASET_REFRESH_CADENCES,
  GOVERNED_FIELD_ROLES,
  deriveDatasetFieldsFromPipeline,
  listPipelinePublicationCandidates,
  publishGovernedDatasetFromPipeline,
  saveRecordProjectionRule,
  updateGovernedFieldGovernance,
  type GovernedFieldRole,
} from "@/server/domains/analytics/governed-datasets";
import { projectDatasetRecords } from "@/server/domains/analytics/record-projection";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

async function requireDatasetGovernor() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    throw new Error("Only a Company Admin or Analyst can govern datasets.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" }),
  );
  return ctx;
}

function uuidValue(formData: FormData, name: string, label: string): string {
  const value = String(formData.get(name) ?? "");
  if (!UUID_PATTERN.test(value)) throw new Error(`Choose a valid ${label}.`);
  return value;
}

function fieldKeyValue(formData: FormData, name: string, label: string, required = true): string | null {
  const value = String(formData.get(name) ?? "").trim();
  if (!value) {
    if (required) throw new Error(`Choose a ${label}.`);
    return null;
  }
  if (!KEY_PATTERN.test(value)) throw new Error(`Choose a valid ${label}.`);
  return value;
}

export async function publishGovernedDatasetAction(formData: FormData): Promise<void> {
  const ctx = await requireDatasetGovernor();
  const pipelineId = uuidValue(formData, "pipelineId", "pipeline");
  const datasetKey = String(formData.get("datasetKey") ?? "").trim().toLocaleLowerCase("en-GB");
  if (!KEY_PATTERN.test(datasetKey)) throw new Error("Dataset key must use lowercase letters, numbers and underscores.");
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const subjectArea = String(formData.get("subjectArea") ?? "").trim();
  const refreshCadence = String(formData.get("refreshCadence") ?? "");
  if (!DATASET_REFRESH_CADENCES.includes(refreshCadence as (typeof DATASET_REFRESH_CADENCES)[number])) {
    throw new Error("Choose a supported refresh cadence.");
  }
  const expectedLatencyHours = Number(formData.get("expectedLatencyHours") ?? 24);

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const candidates = await listPipelinePublicationCandidates(client, { tenantId: ctx.tenant.id });
    const pipeline = candidates.find((candidate) => candidate.id === pipelineId);
    if (!pipeline) throw new Error("The pipeline was not found.");
    const fields = deriveDatasetFieldsFromPipeline(pipeline.fieldMappings, pipeline.keyColumns);
    if (fields.length === 0) {
      throw new Error("Configure the pipeline's included fields in Connect before publishing a governed dataset.");
    }
    const published = await publishGovernedDatasetFromPipeline(client, {
      tenantId: ctx.tenant.id,
      pipelineId,
      datasetKey,
      name,
      description,
      subjectArea,
      refreshCadence,
      expectedLatencyHours,
      fields,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "dataset.published",
      targetType: "governed_dataset",
      targetId: published.datasetId,
      metadata: {
        dataset_key: datasetKey,
        pipeline_id: pipelineId,
        field_count: published.fieldCount,
        sensitive_field_count: fields.filter((field) => field.isSensitive).length,
      },
    });
  });
  revalidatePath("/admin/datasets");
  revalidatePath("/admin/kpis");
}

export async function updateFieldGovernanceAction(formData: FormData): Promise<void> {
  const ctx = await requireDatasetGovernor();
  const datasetId = uuidValue(formData, "datasetId", "dataset");
  const fieldKeys = formData.getAll("fieldKey").map(String);
  const fields = fieldKeys.map((fieldKey) => {
    if (!KEY_PATTERN.test(fieldKey)) throw new Error("A governed field key is invalid.");
    const fieldRole = String(formData.get(`role:${fieldKey}`) ?? "") as GovernedFieldRole;
    if (!GOVERNED_FIELD_ROLES.includes(fieldRole)) throw new Error(`Choose a valid role for '${fieldKey}'.`);
    return {
      fieldKey,
      fieldRole,
      isSensitive: formData.get(`sensitive:${fieldKey}`) !== null,
    };
  });
  if (fields.length === 0) throw new Error("No fields were submitted.");

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const result = await updateGovernedFieldGovernance(client, {
      tenantId: ctx.tenant.id,
      datasetId,
      fields,
      actorUserId: ctx.profileId,
    });
    if (result.changedFields.length === 0) return;
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "dataset.field_governance_changed",
      targetType: "governed_dataset",
      targetId: datasetId,
      metadata: {
        changed_fields: result.changedFields,
        withdrawn_fields: result.withdrawnFields,
      },
    });
  });
  revalidatePath("/admin/datasets");
  revalidatePath("/dashboard");
}

export async function saveProjectionRuleAction(formData: FormData): Promise<void> {
  const ctx = await requireDatasetGovernor();
  const datasetId = uuidValue(formData, "datasetId", "dataset");
  const status = String(formData.get("status") ?? "active");
  if (status !== "active" && status !== "disabled") throw new Error("Choose a valid projection status.");
  const orgCodeFieldKey = fieldKeyValue(formData, "orgCodeFieldKey", "organisation code field")!;
  const occurredAtFieldKey = fieldKeyValue(formData, "occurredAtFieldKey", "record date field")!;
  const measureFieldKey = fieldKeyValue(formData, "measureFieldKey", "contribution field", false);
  const projectedFieldKeys = formData.getAll("projectedFieldKeys").map(String);
  for (const key of projectedFieldKeys) {
    if (!KEY_PATTERN.test(key)) throw new Error("A projected field key is invalid.");
  }
  const maxRecords = Number(formData.get("maxRecords") ?? 5000);

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const ruleId = await saveRecordProjectionRule(client, {
      tenantId: ctx.tenant.id,
      datasetId,
      status,
      orgCodeFieldKey,
      occurredAtFieldKey,
      measureFieldKey,
      projectedFieldKeys,
      maxRecords,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "dataset.record_projection_configured",
      targetType: "governed_dataset",
      targetId: datasetId,
      metadata: {
        rule_id: ruleId,
        status,
        organisation_code_field: orgCodeFieldKey,
        record_date_field: occurredAtFieldKey,
        contribution_field: measureFieldKey,
        projected_fields: projectedFieldKeys,
        max_records: maxRecords,
      },
    });
  });
  revalidatePath("/admin/datasets");
  revalidatePath("/dashboard");
}

export async function refreshRecordProjectionsAction(formData: FormData): Promise<void> {
  const ctx = await requireDatasetGovernor();
  const datasetId = uuidValue(formData, "datasetId", "dataset");

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const result = await projectDatasetRecords(client, {
      tenantId: ctx.tenant.id,
      datasetId,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "dataset.records_projected",
      targetType: "governed_dataset",
      targetId: datasetId,
      metadata: {
        projected_records: result.projectedRecords,
        unmatched_records: result.unmatchedRecords,
        linked_kpi_values: result.linkedKpiValues,
        lineage_links: result.lineageLinks,
        skipped_reasons: result.skippedReasons,
      },
    });
  });
  revalidatePath("/admin/datasets");
  revalidatePath("/dashboard");
}
