import { withUserContext } from "@hized/db";
import { dbPool } from "../../db-pool";
import { syncSqlServerPipeline } from "./sql-server-sync";
import { completeSqlPublication, failSqlPublication } from "./sql-server-publications";

export interface ClaimedSqlPublicationSync {
  tenantId: string;
  connectorId: string;
  pipelineId: string;
  publicationId: string;
  actorUserId: string;
  leaseToken: string;
}

export async function claimDueSqlPublicationSyncs(limit = 5): Promise<ClaimedSqlPublicationSync[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const { rows } = await dbPool.query("select * from public.claim_due_sql_publication_syncs($1)", [bounded]);
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    connectorId: row.connector_id,
    pipelineId: row.pipeline_id,
    publicationId: row.publication_id,
    actorUserId: row.actor_user_id,
    leaseToken: row.lease_token,
  }));
}

export async function runClaimedSqlPublicationSync(job: ClaimedSqlPublicationSync) {
  try {
    const result = await syncSqlServerPipeline({
      tenantId: job.tenantId,
      actorUserId: job.actorUserId,
      pipelineId: job.pipelineId,
      triggerType: "schedule",
    });
    await withUserContext(
      { userId: job.actorUserId, tenantId: job.tenantId },
      (client) => completeSqlPublication(client, {
        tenantId: job.tenantId,
        publicationId: job.publicationId,
        leaseToken: job.leaseToken,
      }),
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The approved SQL publication failed.";
    await withUserContext(
      { userId: job.actorUserId, tenantId: job.tenantId },
      (client) => failSqlPublication(client, {
        tenantId: job.tenantId,
        publicationId: job.publicationId,
        leaseToken: job.leaseToken,
        message,
      }),
    ).catch(() => {});
    throw error;
  }
}
