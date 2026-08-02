"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { createManualFilePipeline } from "@/server/domains/connectors/connectors";

export async function createManualFilePipelineAction(formData: FormData) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    throw new Error("Only a company admin or analyst can configure Connect.");
  }

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Pipeline name must be between 2 and 100 characters.");
  const rawLoadMode = String(formData.get("loadMode") ?? "snapshot");
  if (!(["snapshot", "append", "upsert"] as const).includes(rawLoadMode as "snapshot")) {
    throw new Error("Invalid load mode.");
  }
  const loadMode = rawLoadMode as "snapshot" | "append" | "upsert";
  const keyColumns = String(formData.get("keyColumns") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (loadMode === "upsert" && keyColumns.length === 0) {
    throw new Error("Upsert pipelines require at least one key column.");
  }

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createManualFilePipeline(client, {
      tenantId: ctx.tenant.id,
      createdBy: ctx.profileId,
      name,
      loadMode,
      keyColumns,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.pipeline_created",
      targetType: "pipeline",
      targetId: created.pipelineId,
      metadata: { connectorId: created.connectorId, connectorType: "file_upload", loadMode, keyColumns },
    });
  });

  revalidatePath("/admin/connect");
}
