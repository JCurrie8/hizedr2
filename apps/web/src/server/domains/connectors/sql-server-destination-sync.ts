import { withUserContext } from "@hized/db";
import { insertAuditLog } from "../access-control/audit";
import { assertProductAccess } from "../products/entitlements";
import { replaceSqlServerDestinationSnapshot } from "./sql-server-destination-api";
import {
  acquireSqlDestinationLoadLease,
  beginSqlDestinationLoad,
  completeSqlDestinationLoad,
  completeSqlDestinationNoop,
  recordSqlDestinationLoadFailure,
} from "./sql-server-destinations";

export async function syncPipelineToSqlDestination(input: {
  tenantId: string;
  actorUserId: string;
  pipelineId: string;
  destinationId?: string;
  leaseToken?: string;
  triggerType?: "manual_sync" | "schedule" | "retry";
}): Promise<{ destinationId: string; sourceRunId: string; rowsWritten: number; duplicate: boolean }> {
  if (Boolean(input.leaseToken) !== Boolean(input.destinationId)) {
    throw new Error("A scheduled SQL destination load requires both a destination and its lease token.");
  }
  const lease = input.leaseToken && input.destinationId
    ? { destinationId: input.destinationId, leaseToken: input.leaseToken }
    : await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        async (client) => {
          await assertProductAccess(client, { tenantId: input.tenantId, productKey: "connect" });
          return acquireSqlDestinationLoadLease(client, { tenantId: input.tenantId, pipelineId: input.pipelineId });
        },
      );
  let sourceRunId: string | null = null;

  try {
    const context = await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      async (client) => {
        await assertProductAccess(client, { tenantId: input.tenantId, productKey: "connect" });
        return beginSqlDestinationLoad(client, {
          tenantId: input.tenantId,
          pipelineId: input.pipelineId,
          destinationId: lease.destinationId,
          leaseToken: lease.leaseToken,
        });
      },
    );
    sourceRunId = context.sourceRunId;
    if (context.alreadySucceeded) {
      await withUserContext(
        { userId: input.actorUserId, tenantId: input.tenantId },
        async (client) => {
          await completeSqlDestinationNoop(client, {
            tenantId: input.tenantId,
            destinationId: context.destination.id,
            leaseToken: lease.leaseToken,
          });
          await insertAuditLog(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "connect.sql_destination_unchanged",
            targetType: "pipeline",
            targetId: input.pipelineId,
            metadata: {
              destinationId: context.destination.id,
              sourceRunId: context.sourceRunId,
              triggerType: input.triggerType ?? "manual_sync",
            },
          });
        },
      );
      return {
        destinationId: context.destination.id,
        sourceRunId: context.sourceRunId,
        rowsWritten: 0,
        duplicate: true,
      };
    }

    const result = await replaceSqlServerDestinationSnapshot(context.credentials, {
      managedSchema: context.destination.targetSchema,
      targetTable: context.destination.targetTable,
      pipelineId: context.pipelineId,
      sourceRunId: context.sourceRunId,
      fields: context.fields,
      records: context.records,
    });
    await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      async (client) => {
        await completeSqlDestinationLoad(client, {
          tenantId: input.tenantId,
          destinationId: context.destination.id,
          sourceRunId: context.sourceRunId,
          leaseToken: lease.leaseToken,
          rowsWritten: result.rowsWritten,
          message: `Loaded ${result.rowsWritten} rows into ${context.destination.targetSchema}.${context.destination.targetTable}`,
        });
        await insertAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "connect.sql_destination_loaded",
          targetType: "pipeline",
          targetId: input.pipelineId,
          metadata: {
            destinationId: context.destination.id,
            connectorId: context.destination.connectorId,
            sourceRunId: context.sourceRunId,
            targetSchema: context.destination.targetSchema,
            targetTable: context.destination.targetTable,
            rowsWritten: result.rowsWritten,
            triggerType: input.triggerType ?? "manual_sync",
          },
        });
      },
    );
    return {
      destinationId: context.destination.id,
      sourceRunId: context.sourceRunId,
      rowsWritten: result.rowsWritten,
      duplicate: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The SQL destination load failed.";
    await withUserContext(
      { userId: input.actorUserId, tenantId: input.tenantId },
      async (client) => {
        await recordSqlDestinationLoadFailure(client, {
          tenantId: input.tenantId,
          destinationId: lease.destinationId,
          sourceRunId,
          leaseToken: lease.leaseToken,
          message,
        });
        await insertAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "connect.sql_destination_failed",
          targetType: "pipeline",
          targetId: input.pipelineId,
          metadata: {
            destinationId: lease.destinationId,
            sourceRunId,
            triggerType: input.triggerType ?? "manual_sync",
          },
        });
      },
    ).catch(() => {});
    throw new Error(message);
  }
}
