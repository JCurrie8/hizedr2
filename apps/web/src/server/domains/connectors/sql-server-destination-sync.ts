import { withUserContext } from "@hized/db";
import { insertAuditLog } from "../access-control/audit";
import { assertProductAccess } from "../products/entitlements";
import { replaceSqlServerDestinationSnapshot } from "./sql-server-destination-api";
import { beginSqlDestinationLoad, completeSqlDestinationLoad } from "./sql-server-destinations";

export async function syncPipelineToSqlDestination(input: {
  tenantId: string;
  actorUserId: string;
  pipelineId: string;
}): Promise<{ destinationId: string; sourceRunId: string; rowsWritten: number; duplicate: boolean }> {
  const context = await withUserContext(
    { userId: input.actorUserId, tenantId: input.tenantId },
    async (client) => {
      await assertProductAccess(client, { tenantId: input.tenantId, productKey: "connect" });
      return beginSqlDestinationLoad(client, { tenantId: input.tenantId, pipelineId: input.pipelineId });
    },
  );
  if (context.alreadySucceeded) {
    return {
      destinationId: context.destination.id,
      sourceRunId: context.sourceRunId,
      rowsWritten: 0,
      duplicate: true,
    };
  }

  try {
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
          status: "succeeded",
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
        await completeSqlDestinationLoad(client, {
          tenantId: input.tenantId,
          destinationId: context.destination.id,
          sourceRunId: context.sourceRunId,
          status: "failed",
          rowsWritten: 0,
          message,
        });
        await insertAuditLog(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "connect.sql_destination_failed",
          targetType: "pipeline",
          targetId: input.pipelineId,
          metadata: {
            destinationId: context.destination.id,
            connectorId: context.destination.connectorId,
            sourceRunId: context.sourceRunId,
            targetSchema: context.destination.targetSchema,
            targetTable: context.destination.targetTable,
          },
        });
      },
    ).catch(() => {});
    throw new Error(message);
  }
}
