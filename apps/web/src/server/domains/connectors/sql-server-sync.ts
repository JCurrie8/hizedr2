import { createHash, randomUUID } from "node:crypto";
import { withUserContext } from "@hized/db";
import { insertAuditLog } from "../access-control/audit";
import { assertProductAccess } from "../products/entitlements";
import { deleteR2Object, uploadR2Object } from "../../storage/r2";
import { persistManualFileFailure, persistManualFileRun } from "./connectors";
import { extractSqlServerRows } from "./sql-server-api";
import {
  commitSqlServerCheckpoint,
  getSqlServerSyncContext,
  recordSqlServerFailure,
} from "./sql-server-connectors";

export function sqlServerExtractionWindow(input: {
  watermarkField: string | null;
  committedThroughAt: string | null;
  overlapSeconds: number;
  now: Date;
}): { from: Date | null; to: Date } {
  if (!input.watermarkField || !input.committedThroughAt) return { from: null, to: input.now };
  return {
    from: new Date(new Date(input.committedThroughAt).valueOf() - input.overlapSeconds * 1_000),
    to: input.now,
  };
}

export async function syncSqlServerPipeline(input: {
  tenantId: string;
  actorUserId: string;
  pipelineId: string;
  now?: Date;
}): Promise<{ runId: string; acceptedRows: number; rejectedRows: number; duplicate: boolean }> {
  const context = await withUserContext(
    { userId: input.actorUserId, tenantId: input.tenantId },
    async (client) => {
      await assertProductAccess(client, { tenantId: input.tenantId, productKey: "connect" });
      return getSqlServerSyncContext(client, { tenantId: input.tenantId, pipelineId: input.pipelineId });
    },
  );
  let storageKey: string | null = null;
  let objectReferenced = false;
  try {
    const window = sqlServerExtractionWindow({
      watermarkField: context.watermarkField,
      committedThroughAt: context.committedThroughAt,
      overlapSeconds: context.overlapSeconds,
      now: input.now ?? new Date(),
    });
    const rows = await extractSqlServerRows(context.credentials, {
      schema: context.schema,
      object: context.object,
      fields: context.fields,
      orderFields: context.watermarkField
        ? [context.watermarkField, ...context.pipeline.keyColumns]
        : context.pipeline.keyColumns,
      watermarkField: context.watermarkField,
      windowFrom: window.from,
      windowTo: window.to,
    });
    const bytes = Buffer.from(JSON.stringify(rows), "utf8");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const windowFrom = window.from?.toISOString() ?? null;
    const windowTo = window.to.toISOString();
    const fileName = `${context.schema}.${context.object}-${windowTo.replace(/[:.]/g, "-")}.json`;
    storageKey = `${input.tenantId}/connect/${context.connectorId}/${windowTo.slice(0, 10)}/${randomUUID()}-${fileName}`;
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
      sourceItemId: `${context.credentials.database}:${context.schema}.${context.object}`,
      sourcePath: `${context.credentials.server}:${context.credentials.port}/${context.credentials.database}/${context.schema}.${context.object}`,
      batchKind: "api_extract" as const,
      windowStartedAt: windowFrom,
      windowEndedAt: windowTo,
      cursorStart: { committedThroughAt: context.committedThroughAt, windowFrom },
      cursorEnd: { committedThroughAt: windowTo },
      triggerType: "manual_sync" as const,
      sourceMetadata: {
        provider: context.connectorType,
        schema: context.schema,
        object: context.object,
        watermarkField: context.watermarkField,
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
              sourceName: `${context.schema}.${context.object}`,
              sheetName: null,
              headers: context.fields,
              rows,
            },
          });
          await commitSqlServerCheckpoint(client, {
            tenantId: input.tenantId,
            connectorId: context.connectorId,
            pipelineId: context.pipeline.id,
            expected: context.committedThroughAt,
            committedThroughAt: windowTo,
          });
          await insertAuditLog(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: result.duplicate ? "connect.sql_extract_duplicate" : "connect.run_completed",
            targetType: "pipeline_run",
            targetId: result.runId,
            metadata: {
              connectorId: context.connectorId,
              pipelineId: context.pipeline.id,
              schema: context.schema,
              object: context.object,
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
      const message = error instanceof Error ? error.message : "The SQL Server extract could not be processed.";
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
              metadata: { connectorId: context.connectorId, pipelineId: context.pipeline.id, schema: context.schema, object: context.object },
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
      runId: persisted.runId,
      acceptedRows: persisted.acceptedRows,
      rejectedRows: persisted.rejectedRows,
      duplicate: persisted.duplicate,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The SQL Server synchronization failed.";
    await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      (client) => recordSqlServerFailure(client, { tenantId: input.tenantId, connectorId: context.connectorId, message }),
    ).catch(() => {});
    throw new Error(message);
  }
}
