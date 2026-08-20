import { dbPool } from "../../db-pool";
import { syncPipelineToSqlDestination } from "./sql-server-destination-sync";

export interface ClaimedSqlDestinationSync {
  tenantId: string;
  connectorId: string;
  pipelineId: string;
  destinationId: string;
  actorUserId: string;
  leaseToken: string;
}

/**
 * Background-only exception to authenticated querying. The fixed database
 * function returns identifiers only; every claimed load immediately re-enters
 * normal user/tenant RLS before reading source rows or destination secrets.
 */
export async function claimDueSqlDestinationSyncs(limit = 5): Promise<ClaimedSqlDestinationSync[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const { rows } = await dbPool.query(
    "select * from public.claim_due_sql_destination_syncs($1)",
    [boundedLimit],
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    connectorId: row.connector_id,
    pipelineId: row.pipeline_id,
    destinationId: row.destination_id,
    actorUserId: row.actor_user_id,
    leaseToken: row.lease_token,
  }));
}

export async function runClaimedSqlDestinationSync(job: ClaimedSqlDestinationSync) {
  return syncPipelineToSqlDestination({
    tenantId: job.tenantId,
    actorUserId: job.actorUserId,
    pipelineId: job.pipelineId,
    destinationId: job.destinationId,
    leaseToken: job.leaseToken,
    triggerType: "schedule",
  });
}
