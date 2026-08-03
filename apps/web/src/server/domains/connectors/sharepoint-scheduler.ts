import { dbPool } from "../../db-pool";
import { syncSharePointWorkbook, type SharePointSyncResult } from "./sharepoint-sync";

export interface ClaimedSharePointSync {
  tenantId: string;
  connectorId: string;
  pipelineId: string;
  actorUserId: string;
  leaseToken: string;
}

/**
 * Background-only exception to the authenticated-query rule. The restricted
 * app_user may execute this one fixed SECURITY DEFINER function, which returns
 * only job identifiers and an active Connect operator. It does not grant raw
 * cross-tenant table access; the claimed sync itself re-enters ordinary RLS
 * through syncSharePointWorkbook + withUserContext.
 */
export async function claimDueSharePointSyncs(limit = 5): Promise<ClaimedSharePointSync[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const { rows } = await dbPool.query(
    "select * from public.claim_due_sharepoint_syncs($1)",
    [boundedLimit],
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    connectorId: row.connector_id,
    pipelineId: row.pipeline_id,
    actorUserId: row.actor_user_id,
    leaseToken: row.lease_token,
  }));
}

export async function runClaimedSharePointSync(job: ClaimedSharePointSync): Promise<SharePointSyncResult> {
  return syncSharePointWorkbook({
    tenantId: job.tenantId,
    actorUserId: job.actorUserId,
    pipelineId: job.pipelineId,
    leaseToken: job.leaseToken,
    triggerType: "schedule",
  });
}
