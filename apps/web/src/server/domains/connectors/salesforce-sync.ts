import { createHash, randomUUID } from "node:crypto";
import { withUserContext } from "@hized/db";
import { insertAuditLog } from "../access-control/audit";
import { assertProductAccess } from "../products/entitlements";
import { deleteR2Object, uploadR2Object } from "../../storage/r2";
import { authenticateSalesforce, extractSalesforceRecords } from "./salesforce-api";
import {
  acquireSalesforceSyncLease,
  commitSalesforceSyncSuccess,
  getSalesforceSyncContext,
  recordSalesforceSyncFailure,
} from "./salesforce-connectors";
import { persistManualFileFailure, persistManualFileRun } from "./connectors";

export interface SalesforceSyncResult {
  outcome: "loaded";
  runId: string;
  duplicate: boolean;
  acceptedRows: number;
  rejectedRows: number;
  windowFrom: string | null;
  windowTo: string;
}

export function salesforceExtractionWindow(input: {
  committedThroughAt: string | null;
  overlapSeconds: number;
  initialLookbackSeconds: number | null;
  now: Date;
}): { from: Date | null; to: Date } {
  if (input.committedThroughAt) {
    return {
      from: new Date(new Date(input.committedThroughAt).valueOf() - input.overlapSeconds * 1_000),
      to: input.now,
    };
  }
  return {
    from: input.initialLookbackSeconds === null
      ? null
      : new Date(input.now.valueOf() - input.initialLookbackSeconds * 1_000),
    to: input.now,
  };
}

export async function syncSalesforcePipeline(input: {
  tenantId: string;
  actorUserId: string;
  pipelineId: string;
  leaseToken?: string;
  triggerType?: "manual_sync" | "schedule" | "retry" | "backfill";
  now?: Date;
}): Promise<SalesforceSyncResult> {
  const context = await withUserContext(
    { userId: input.actorUserId, tenantId: input.tenantId },
    async (client) => {
      await assertProductAccess(client, { tenantId: input.tenantId, productKey: "connect" });
      return getSalesforceSyncContext(client, { tenantId: input.tenantId, pipelineId: input.pipelineId });
    },
  );
  const leaseToken = input.leaseToken ?? await withUserContext(
    { userId: input.actorUserId, tenantId: input.tenantId },
    (client) => acquireSalesforceSyncLease(client, {
      tenantId: input.tenantId,
      pipelineId: input.pipelineId,
    }),
  );
  let storageKey: string | null = null;
  let objectReferenced = false;

  try {
    const now = input.now ?? new Date();
    const window = salesforceExtractionWindow({
      committedThroughAt: context.committedThroughAt,
      overlapSeconds: context.overlapSeconds,
      initialLookbackSeconds: context.initialLookbackSeconds,
      now,
    });
    const session = await authenticateSalesforce(context.credentials);
    const records = await extractSalesforceRecords({
      session,
      apiVersion: context.apiVersion,
      objectName: context.objectName,
      fields: context.fields,
      modifiedField: context.modifiedField,
      windowFrom: window.from,
      windowTo: window.to,
      includeDeleted: context.includeDeleted,
    });
    const bytes = Buffer.from(JSON.stringify(records), "utf8");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const windowFrom = window.from?.toISOString() ?? null;
    const windowTo = window.to.toISOString();
    const day = windowTo.slice(0, 10);
    const fileName = `${context.objectName}-${windowTo.replace(/[:.]/g, "-")}.json`;
    storageKey = `${input.tenantId}/connect/${context.connectorId}/${day}/${randomUUID()}-${fileName}`;
    await uploadR2Object({
      key: storageKey,
      bytes,
      contentType: "application/json",
      metadata: { tenantId: input.tenantId, pipelineId: context.pipeline.id, contentSha256 },
    });
    const sourceInput = {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      pipeline: context.pipeline,
      fileName,
      contentType: "application/json",
      contentSha256,
      sizeBytes: bytes.byteLength,
      storageKey,
      sourceModifiedAt: windowTo,
      sourceItemId: `${context.objectName}:${windowFrom ?? "beginning"}:${windowTo}`,
      sourcePath: `${context.credentials.myDomainUrl}/${context.objectName}`,
      batchKind: "api_extract" as const,
      windowStartedAt: windowFrom,
      windowEndedAt: windowTo,
      cursorStart: { committedThroughAt: context.committedThroughAt, windowFrom },
      cursorEnd: { committedThroughAt: windowTo },
      triggerType: input.triggerType ?? "manual_sync",
      deletionField: context.includeDeleted && context.fields.includes("IsDeleted") ? "IsDeleted" : undefined,
      sourceMetadata: {
        provider: "salesforce",
        apiVersion: context.apiVersion,
        object: context.objectName,
        modifiedField: context.modifiedField,
        overlapSeconds: context.overlapSeconds,
      },
    };

    let persisted;
    try {
      persisted = await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        async (client) => {
          const result = await persistManualFileRun(client, {
            ...sourceInput,
            table: {
              sourceName: context.objectName,
              sheetName: null,
              headers: context.fields,
              rows: records,
            },
          });
          await commitSalesforceSyncSuccess(client, {
            tenantId: input.tenantId,
            connectorId: context.connectorId,
            pipelineId: context.pipeline.id,
            expectedCommittedThroughAt: context.committedThroughAt,
            committedThroughAt: windowTo,
            leaseToken,
          });
          await insertAuditLog(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: result.duplicate ? "connect.salesforce_extract_duplicate" : "connect.run_completed",
            targetType: "pipeline_run",
            targetId: result.runId,
            metadata: {
              connectorId: context.connectorId,
              pipelineId: context.pipeline.id,
              object: context.objectName,
              triggerType: input.triggerType ?? "manual_sync",
              windowFrom,
              windowTo,
              acceptedRows: result.acceptedRows,
              rejectedRows: result.rejectedRows,
            },
          });
          return result;
        },
      );
      objectReferenced = !persisted.sourceObjectReused;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Salesforce extract could not be processed.";
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
              metadata: { connectorId: context.connectorId, pipelineId: context.pipeline.id, object: context.objectName },
            });
            return result;
          },
        );
        objectReferenced = !failure.sourceObjectReused;
      } finally {
        if (!objectReferenced && storageKey) await deleteR2Object(storageKey).catch(() => {});
      }
      throw error;
    }

    if (persisted.sourceObjectReused && storageKey) await deleteR2Object(storageKey).catch(() => {});
    return {
      outcome: "loaded",
      runId: persisted.runId,
      duplicate: persisted.duplicate,
      acceptedRows: persisted.acceptedRows,
      rejectedRows: persisted.rejectedRows,
      windowFrom,
      windowTo,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Salesforce synchronization failed.";
    await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      (client) => recordSalesforceSyncFailure(client, {
        tenantId: input.tenantId,
        connectorId: context.connectorId,
        pipelineId: context.pipeline.id,
        leaseToken,
        message,
      }),
    ).catch(() => {});
    throw new Error(message);
  }
}
