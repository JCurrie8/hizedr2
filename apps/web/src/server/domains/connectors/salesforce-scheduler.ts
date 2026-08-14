import { dbPool } from "../../db-pool";
import { syncSalesforcePipeline, type SalesforceSyncResult } from "./salesforce-sync";

export interface ClaimedSalesforceSync {
  tenantId: string;
  connectorId: string;
  pipelineId: string;
  actorUserId: string;
  leaseToken: string;
}

/**
 * Background-only exception to authenticated querying. The fixed database
 * function returns identifiers only; every claimed job then uses normal
 * user/tenant RLS through syncSalesforcePipeline.
 */
export async function claimDueSalesforceSyncs(limit = 5): Promise<ClaimedSalesforceSync[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const { rows } = await dbPool.query(
    "select * from public.claim_due_salesforce_syncs($1)",
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

export async function runClaimedSalesforceSync(job: ClaimedSalesforceSync): Promise<SalesforceSyncResult> {
  return syncSalesforcePipeline({
    tenantId: job.tenantId,
    actorUserId: job.actorUserId,
    pipelineId: job.pipelineId,
    leaseToken: job.leaseToken,
    triggerType: "schedule",
  });
}
