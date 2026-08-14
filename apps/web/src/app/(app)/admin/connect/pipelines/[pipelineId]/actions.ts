"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import { savePipelineBuilderConfiguration } from "@/server/domains/connectors/pipeline-configuration";
import type { LoadMode, PipelineDataType } from "@/server/domains/connectors/tabular-load";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_TYPES = new Set<PipelineDataType>(["string", "integer", "numeric", "boolean", "date", "timestamp"]);

async function requireConnectOperator() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    throw new Error("Only a company admin or analyst can configure Connect.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" }),
  );
  return ctx;
}

export async function savePipelineConfigurationAction(pipelineId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid pipeline.");

  const name = String(formData.get("name") ?? "").trim();
  const rawLoadMode = String(formData.get("loadMode") ?? "snapshot");
  if (!(rawLoadMode === "snapshot" || rawLoadMode === "append" || rawLoadMode === "upsert")) {
    throw new Error("Invalid load mode.");
  }
  const loadMode = rawLoadMode as LoadMode;
  const keyColumns = String(formData.get("keyColumns") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const mappingCount = Number(formData.get("mappingCount") ?? 0);
  if (!Number.isInteger(mappingCount) || mappingCount < 0 || mappingCount > 250) throw new Error("Invalid field mapping count.");
  const fieldMappings = Array.from({ length: mappingCount }, (_, position) => {
    const dataType = String(formData.get(`dataType:${position}`) ?? "string") as PipelineDataType;
    if (!DATA_TYPES.has(dataType)) throw new Error("Invalid field data type.");
    return {
      sourceField: String(formData.get(`sourceField:${position}`) ?? ""),
      targetField: String(formData.get(`targetField:${position}`) ?? ""),
      dataType,
      isIncluded: formData.get(`included:${position}`) === "on",
      isRequired: formData.get(`required:${position}`) === "on",
      position,
    };
  });
  const rawPollInterval = String(formData.get("pollIntervalMinutes") ?? "").trim();
  const pollIntervalMinutes = rawPollInterval ? Number(rawPollInterval) : null;
  const changeNote = String(formData.get("changeNote") ?? "").trim() || null;

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const saved = await savePipelineBuilderConfiguration(client, {
      tenantId: ctx.tenant.id,
      pipelineId,
      actorUserId: ctx.profileId,
      name,
      loadMode,
      keyColumns,
      fieldMappings,
      pollIntervalMinutes,
      changeNote,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.pipeline_configuration_saved",
      targetType: "pipeline",
      targetId: pipelineId,
      metadata: {
        versionNumber: saved.versionNumber,
        connectorType: saved.connectorType,
        loadMode: saved.loadMode,
        keyColumns: saved.keyColumns,
        mappedFields: fieldMappings.filter((mapping) => mapping.isIncluded).length,
        pollIntervalMinutes: saved.pollIntervalMinutes,
      },
    });
  });

  revalidatePath(`/admin/connect/pipelines/${pipelineId}`);
  revalidatePath("/admin/connect");
}
