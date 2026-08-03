"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import {
  createManualFilePipeline,
  getManualFilePipeline,
  persistManualFileFailure,
  persistManualFileRun,
} from "@/server/domains/connectors/connectors";
import { parseTabularFile } from "@/server/domains/connectors/tabular-file";
import { resolveMicrosoftWorkbook } from "@/server/domains/connectors/microsoft-graph";
import {
  createMicrosoftAuthorizationUrl,
  createMicrosoftOAuthState,
  ensureFreshMicrosoftCredentials,
  microsoftConnectorEnvironmentReady,
} from "@/server/domains/connectors/microsoft-oauth";
import {
  configureMicrosoftWorkbookPipeline,
  getMicrosoftConnectorCredentials,
  replaceMicrosoftConnectorCredentials,
} from "@/server/domains/connectors/sharepoint-connectors";
import { syncSharePointWorkbook } from "@/server/domains/connectors/sharepoint-sync";
import {
  createR2Upload,
  deleteR2Object,
  downloadR2Object,
  verifyR2Upload,
} from "@/server/storage/r2";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function validateUploadInput(input: {
  pipelineId: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
}) {
  if (!UUID_PATTERN.test(input.pipelineId)) throw new Error("Invalid pipeline.");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error("Files must be between 1 byte and 10 MB.");
  }
  if (!SHA256_PATTERN.test(input.contentSha256)) throw new Error("Invalid file hash.");
  const extension = input.fileName.toLocaleLowerCase("en-GB").split(".").pop();
  if (extension !== "csv" && extension !== "xlsx") throw new Error("Only .csv and .xlsx files are supported.");
  return extension;
}

function safeStorageFileName(fileName: string): string {
  const leaf = fileName.replaceAll("\\", "/").split("/").pop() ?? "upload";
  return leaf.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "upload";
}

export async function createManualFilePipelineAction(formData: FormData) {
  const ctx = await requireConnectOperator();

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

function parsePipelineConfig(formData: FormData) {
  const pipelineName = String(formData.get("pipelineName") ?? "").trim();
  if (pipelineName.length < 2 || pipelineName.length > 100) {
    throw new Error("Pipeline name must be between 2 and 100 characters.");
  }
  const rawLoadMode = String(formData.get("loadMode") ?? "snapshot");
  if (!("snapshot" === rawLoadMode || "append" === rawLoadMode || "upsert" === rawLoadMode)) {
    throw new Error("Invalid load mode.");
  }
  const loadMode = rawLoadMode as "snapshot" | "append" | "upsert";
  const keyColumns = String(formData.get("keyColumns") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (loadMode === "upsert" && keyColumns.length === 0) {
    throw new Error("Upsert pipelines require at least one key column, such as Response ID.");
  }
  return { pipelineName, loadMode, keyColumns };
}

export async function beginMicrosoftConnectionAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!microsoftConnectorEnvironmentReady()) {
    throw new Error("Microsoft Connect is not configured in this deployment yet.");
  }
  const connectorName = String(formData.get("name") ?? "").trim();
  if (connectorName.length < 2 || connectorName.length > 100) {
    throw new Error("Connection name must be between 2 and 100 characters.");
  }
  const state = createMicrosoftOAuthState({
    tenantId: ctx.tenant.id,
    tenantSlug: ctx.tenant.slug,
    profileId: ctx.profileId,
    connectorName,
  });
  redirect(createMicrosoftAuthorizationUrl(state));
}

export async function configureMicrosoftWorkbookAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const connectorId = String(formData.get("connectorId") ?? "");
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Invalid Microsoft connector.");
  const sourceKind = String(formData.get("sourceKind") ?? "sharepoint");
  if (sourceKind !== "sharepoint" && sourceKind !== "onedrive") throw new Error("Invalid Microsoft source type.");
  const workbookPath = String(formData.get("workbookPath") ?? "").trim();
  if (workbookPath.length < 3 || workbookPath.length > 1_000) throw new Error("Enter the workbook path.");
  const siteUrl = String(formData.get("siteUrl") ?? "").trim();
  const pipelineConfig = parsePipelineConfig(formData);

  const credentials = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getMicrosoftConnectorCredentials(client, { tenantId: ctx.tenant.id, connectorId }),
  );
  const fresh = await ensureFreshMicrosoftCredentials(credentials);
  if (fresh.refreshed) {
    await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => replaceMicrosoftConnectorCredentials(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        credentials: fresh.credentials,
      }),
    );
  }
  const source = await resolveMicrosoftWorkbook({
    accessToken: fresh.credentials.accessToken,
    sourceKind,
    workbookPath,
    siteUrl: siteUrl || undefined,
  });
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const created = await configureMicrosoftWorkbookPipeline(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        createdBy: ctx.profileId,
        ...pipelineConfig,
        source,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sharepoint_pipeline_configured",
        targetType: "pipeline",
        targetId: created.pipelineId,
        metadata: {
          connectorId,
          sourceKind,
          driveId: source.driveId,
          driveItemId: source.driveItemId,
          sourceName: source.sourceName,
          loadMode: pipelineConfig.loadMode,
          keyColumns: pipelineConfig.keyColumns,
        },
      });
    },
  );
  revalidatePath("/admin/connect");
}

export async function syncMicrosoftWorkbookAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const pipelineId = String(formData.get("pipelineId") ?? "");
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid SharePoint pipeline.");
  await syncSharePointWorkbook({ tenantId: ctx.tenant.id, actorUserId: ctx.profileId, pipelineId });
  revalidatePath("/admin/connect");
}

export interface PreparedManualUpload {
  pipelineId: string;
  connectorId: string;
  storageKey: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

export async function prepareManualUploadAction(input: {
  pipelineId: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
}): Promise<PreparedManualUpload> {
  const ctx = await requireConnectOperator();
  const extension = validateUploadInput(input);
  const contentType = extension === "csv"
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pipeline = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getManualFilePipeline(client, { tenantId: ctx.tenant.id, pipelineId: input.pipelineId }),
  );
  const day = new Date().toISOString().slice(0, 10);
  const storageKey = `${ctx.tenant.id}/connect/${pipeline.connectorId}/${day}/${randomUUID()}-${safeStorageFileName(input.fileName)}`;
  const upload = await createR2Upload({
    key: storageKey,
    contentType,
    metadata: {
      tenantId: ctx.tenant.id,
      pipelineId: pipeline.id,
      contentSha256: input.contentSha256,
    },
  });
  return {
    pipelineId: pipeline.id,
    connectorId: pipeline.connectorId,
    storageKey,
    uploadUrl: upload.uploadUrl,
    uploadHeaders: upload.headers,
    expiresAt: upload.expiresAt,
  };
}

export async function finaliseManualUploadAction(input: {
  pipelineId: string;
  connectorId: string;
  storageKey: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
  sourceLastModified: number | null;
}) {
  const ctx = await requireConnectOperator();
  const extension = validateUploadInput(input);
  const contentType = extension === "csv"
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pipeline = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getManualFilePipeline(client, { tenantId: ctx.tenant.id, pipelineId: input.pipelineId }),
  );
  if (pipeline.connectorId !== input.connectorId) throw new Error("The upload connector does not match the pipeline.");
  const requiredPrefix = `${ctx.tenant.id}/connect/${pipeline.connectorId}/`;
  if (!input.storageKey.startsWith(requiredPrefix) || input.storageKey.includes("..")) {
    throw new Error("The upload storage key is outside this tenant and connector.");
  }

  await verifyR2Upload({
    key: input.storageKey,
    sizeBytes: input.sizeBytes,
    metadata: {
      tenantId: ctx.tenant.id,
      pipelineId: pipeline.id,
      contentSha256: input.contentSha256,
    },
  });
  const bytes = await downloadR2Object(input.storageKey);
  const serverHash = createHash("sha256").update(bytes).digest("hex");
  if (serverHash !== input.contentSha256) throw new Error("The uploaded file hash does not match its content.");
  const sourceModifiedAt = input.sourceLastModified && Number.isFinite(input.sourceLastModified)
    ? new Date(input.sourceLastModified).toISOString()
    : null;
  const sourceInput = {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.profileId,
    pipeline,
    fileName: input.fileName,
    contentType,
    contentSha256: input.contentSha256,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    sourceModifiedAt,
  };

  let result;
  try {
    const table = await parseTabularFile({ bytes, fileName: input.fileName });
    result = await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        const persisted = await persistManualFileRun(client, { ...sourceInput, table });
        await insertAuditLog(client, {
          tenantId: ctx.tenant.id,
          actorUserId: ctx.profileId,
          action: persisted.duplicate ? "connect.upload_duplicate" : "connect.run_completed",
          targetType: "pipeline_run",
          targetId: persisted.runId,
          metadata: {
            pipelineId: pipeline.id,
            fileName: input.fileName,
            contentSha256: input.contentSha256,
            status: persisted.status,
            acceptedRows: persisted.acceptedRows,
            rejectedRows: persisted.rejectedRows,
          },
        });
        return persisted;
      },
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "The file could not be processed.";
    const failure = await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        const failed = await persistManualFileFailure(client, { ...sourceInput, errorMessage });
        await insertAuditLog(client, {
          tenantId: ctx.tenant.id,
          actorUserId: ctx.profileId,
          action: "connect.run_failed",
          targetType: "pipeline_run",
          targetId: failed.runId,
          metadata: {
            pipelineId: pipeline.id,
            fileName: input.fileName,
            contentSha256: input.contentSha256,
            error: errorMessage.slice(0, 500),
          },
        });
        return failed;
      },
    );
    if (failure.sourceObjectReused) await deleteR2Object(input.storageKey).catch(() => {});
    revalidatePath("/admin/connect");
    throw new Error(errorMessage);
  }

  if (result.sourceObjectReused) await deleteR2Object(input.storageKey).catch(() => {});
  revalidatePath("/admin/connect");
  return result;
}
