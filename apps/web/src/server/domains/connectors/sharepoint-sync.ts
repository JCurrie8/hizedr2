import { createHash, randomUUID } from "node:crypto";
import { withUserContext } from "@hized/db";
import { insertAuditLog } from "../access-control/audit";
import { persistManualFileFailure, persistManualFileRun } from "./connectors";
import {
  collectMicrosoftDriveDelta,
  downloadMicrosoftWorkbook,
  getMicrosoftWorkbook,
  seedMicrosoftDriveDelta,
} from "./microsoft-graph";
import { ensureFreshMicrosoftCredentials } from "./microsoft-oauth";
import {
  acquireSharePointSyncLease,
  commitSharePointSelectedItemDeleted,
  commitSharePointSyncSuccess,
  getSharePointSyncContext,
  recordSharePointSyncFailure,
  replaceMicrosoftConnectorCredentials,
} from "./sharepoint-connectors";
import { parseTabularFile } from "./tabular-file";
import { deleteR2Object, uploadR2Object } from "../../storage/r2";
import { assertProductAccess } from "../products/entitlements";

function safeStorageFileName(fileName: string): string {
  const leaf = fileName.replaceAll("\\", "/").split("/").pop() ?? "workbook";
  return leaf.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "workbook";
}

function contentType(fileName: string): string {
  return fileName.toLocaleLowerCase("en-GB").endsWith(".csv")
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export interface SharePointSyncResult {
  outcome: "loaded" | "unchanged" | "source_deleted";
  runId?: string;
  duplicate?: boolean;
  acceptedRows?: number;
  rejectedRows?: number;
}

export async function syncSharePointWorkbook(input: {
  tenantId: string;
  actorUserId: string;
  pipelineId: string;
  leaseToken?: string;
  triggerType?: "manual_sync" | "schedule" | "webhook" | "retry" | "backfill";
}): Promise<SharePointSyncResult> {
  const context = await withUserContext(
    { userId: input.actorUserId, tenantId: input.tenantId },
    async (client) => {
      await assertProductAccess(client, { tenantId: input.tenantId, productKey: "connect" });
      return getSharePointSyncContext(client, { tenantId: input.tenantId, pipelineId: input.pipelineId });
    },
  );
  const leaseToken = input.leaseToken ?? await withUserContext(
    { userId: input.actorUserId, tenantId: input.tenantId },
    (client) => acquireSharePointSyncLease(client, {
      tenantId: input.tenantId,
      connectorId: context.connectorId,
    }),
  );

  try {
    const fresh = await ensureFreshMicrosoftCredentials(context.credentials);
    if (fresh.refreshed) {
      await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        (client) => replaceMicrosoftConnectorCredentials(client, {
          tenantId: input.tenantId,
          connectorId: context.connectorId,
          credentials: fresh.credentials,
        }),
      );
    }

    let deltaLink: string;
    let shouldDownload = false;
    let selectedDeleted = false;
    if (context.deltaLink) {
      const delta = await collectMicrosoftDriveDelta({
        accessToken: fresh.credentials.accessToken,
        deltaLink: context.deltaLink,
        selectedItemIds: new Set([context.source.driveItemId]),
      });
      deltaLink = delta.deltaLink;
      const selectedChange = delta.changes.find((change) => change.driveItemId === context.source.driveItemId);
      shouldDownload = selectedChange?.kind === "download";
      selectedDeleted = selectedChange?.kind === "delete";
    } else {
      // Take the initial cursor first. If the workbook changes while the
      // current revision is downloaded, the next delta scan still sees it.
      deltaLink = await seedMicrosoftDriveDelta(fresh.credentials.accessToken, context.source.driveId);
      shouldDownload = true;
    }

    if (selectedDeleted) {
      await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        async (client) => {
          await commitSharePointSelectedItemDeleted(client, {
            tenantId: input.tenantId,
            connectorId: context.connectorId,
            pipelineId: context.pipeline.id,
            deltaLink,
            expectedDeltaLink: context.deltaLink,
            leaseToken,
          });
          await insertAuditLog(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "connect.sharepoint_source_deleted",
            targetType: "pipeline",
            targetId: context.pipeline.id,
            metadata: { connectorId: context.connectorId, driveItemId: context.source.driveItemId },
          });
        },
      );
      return { outcome: "source_deleted" };
    }

    if (!shouldDownload) {
      await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        (client) => commitSharePointSyncSuccess(client, {
          tenantId: input.tenantId,
          connectorId: context.connectorId,
          pipelineId: context.pipeline.id,
          deltaLink,
          expectedDeltaLink: context.deltaLink,
          leaseToken,
        }),
      );
      return { outcome: "unchanged" };
    }

    const current = await getMicrosoftWorkbook({
      accessToken: fresh.credentials.accessToken,
      driveId: context.source.driveId,
      driveItemId: context.source.driveItemId,
    });
    const source = { ...current, sourceKind: context.source.sourceKind, siteId: context.source.siteId };
    const bytes = await downloadMicrosoftWorkbook({
      accessToken: fresh.credentials.accessToken,
      driveId: source.driveId,
      driveItemId: source.driveItemId,
    });
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const day = new Date().toISOString().slice(0, 10);
    const storageKey = `${input.tenantId}/connect/${context.connectorId}/${day}/${randomUUID()}-${safeStorageFileName(source.sourceName)}`;
    const mime = contentType(source.sourceName);
    await uploadR2Object({
      key: storageKey,
      bytes,
      contentType: mime,
      metadata: { tenantId: input.tenantId, pipelineId: context.pipeline.id, contentSha256 },
    });

    const sourceInput = {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      pipeline: context.pipeline,
      fileName: source.sourceName,
      contentType: mime,
      contentSha256,
      sizeBytes: bytes.byteLength,
      storageKey,
      sourceModifiedAt: source.sourceModifiedAt,
      sourceItemId: source.driveItemId,
      sourcePath: source.sourcePath,
      sourceETag: source.sourceETag,
      sourceCTag: source.sourceCTag,
      triggerType: input.triggerType ?? "manual_sync",
      sourceMetadata: {
        provider: "microsoft_graph",
        sourceKind: source.sourceKind,
        siteId: source.siteId,
        driveId: source.driveId,
      },
    };

    let persisted;
    let objectReferenced = false;
    try {
      const table = await parseTabularFile({ bytes, fileName: source.sourceName });
      persisted = await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        async (client) => {
          const result = await persistManualFileRun(client, { ...sourceInput, table });
          await insertAuditLog(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: result.duplicate ? "connect.sharepoint_revision_duplicate" : "connect.run_completed",
            targetType: "pipeline_run",
            targetId: result.runId,
            metadata: {
              connectorId: context.connectorId,
              pipelineId: context.pipeline.id,
              driveItemId: source.driveItemId,
              sourceName: source.sourceName,
              contentSha256,
              triggerType: input.triggerType ?? "manual_sync",
              acceptedRows: result.acceptedRows,
              rejectedRows: result.rejectedRows,
            },
          });
          return result;
        },
      );
      objectReferenced = !persisted.sourceObjectReused;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Microsoft workbook could not be processed.";
      try {
        const failure = await withUserContext(
          { userId: input.actorUserId, tenantId: input.tenantId },
          async (client) => {
            const result = await persistManualFileFailure(client, { ...sourceInput, errorMessage: message });
            await insertAuditLog(client, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "connect.run_failed",
              targetType: "pipeline_run",
              targetId: result.runId,
              metadata: { connectorId: context.connectorId, pipelineId: context.pipeline.id, driveItemId: source.driveItemId },
            });
            return result;
          },
        );
        objectReferenced = !failure.sourceObjectReused;
      } finally {
        if (!objectReferenced) await deleteR2Object(storageKey).catch(() => {});
      }
      throw error;
    }

    if (persisted.sourceObjectReused) await deleteR2Object(storageKey).catch(() => {});
    await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      (client) => commitSharePointSyncSuccess(client, {
        tenantId: input.tenantId,
        connectorId: context.connectorId,
        pipelineId: context.pipeline.id,
        deltaLink,
        expectedDeltaLink: context.deltaLink,
        leaseToken,
      }),
    );
    return {
      outcome: "loaded",
      runId: persisted.runId,
      duplicate: persisted.duplicate,
      acceptedRows: persisted.acceptedRows,
      rejectedRows: persisted.rejectedRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The SharePoint synchronization failed.";
    await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      (client) => recordSharePointSyncFailure(client, {
        tenantId: input.tenantId,
        connectorId: context.connectorId,
        message,
        leaseToken,
      }),
    ).catch(() => {});
    throw new Error(message);
  }
}
