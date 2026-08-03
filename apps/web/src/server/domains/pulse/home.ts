import type { PoolClient } from "@neondatabase/serverless";
import {
  listConnectorOverview,
  listRecentPipelineRuns,
  type ConnectorOverview,
  type PipelineRunOverview,
} from "../connectors/connectors";
import { getPulseHierarchy, listPulseKpiCards, type PulseHierarchy, type PulseKpiCard } from "./kpis";

export interface PulseHomeSnapshot {
  organisation: {
    visibleNodes: number;
    teams: number;
    employees: number;
  };
  hierarchy: PulseHierarchy | null;
  kpis: PulseKpiCard[];
  connect: null | {
    connectors: ConnectorOverview[];
    recentRuns: PipelineRunOverview[];
    pipelineCount: number;
    failedRuns: number;
    warningRuns: number;
    recentRowsAccepted: number;
    latestRunAt: string | null;
  };
}

export async function getPulseHomeSnapshot(
  client: PoolClient,
  input: { tenantId: string; includeConnectHealth: boolean; requestedOrgNodeId?: string | null },
): Promise<PulseHomeSnapshot> {
  const { rows: [organisation] } = await client.query(
    `select
       count(*)::integer as visible_nodes,
       count(*) filter (where n.node_type = 'team')::integer as teams,
       count(*) filter (where n.node_type = 'employee')::integer as employees
     from public.org_nodes n
     join public.org_node_versions v
       on v.org_node_id = n.id and v.tenant_id = n.tenant_id
     where n.tenant_id = $1
       and v.valid_from <= current_date
       and (v.valid_to is null or v.valid_to > current_date)`,
    [input.tenantId],
  );

  const organisationSummary = {
    visibleNodes: Number(organisation?.visible_nodes ?? 0),
    teams: Number(organisation?.teams ?? 0),
    employees: Number(organisation?.employees ?? 0),
  };

  const hierarchy = await getPulseHierarchy(client, {
    tenantId: input.tenantId,
    requestedOrgNodeId: input.requestedOrgNodeId,
  });
  const kpis = await listPulseKpiCards(client, {
    tenantId: input.tenantId,
    orgNodeId: hierarchy?.selected.id,
  });

  if (!input.includeConnectHealth) {
    return { organisation: organisationSummary, hierarchy, kpis, connect: null };
  }

  const [connectors, recentRuns] = await Promise.all([
    listConnectorOverview(client, { tenantId: input.tenantId }),
    listRecentPipelineRuns(client, { tenantId: input.tenantId, limit: 20 }),
  ]);
  const latestRunAt = recentRuns[0]?.queuedAt
    ?? connectors.map((connector) => connector.lastRunAt).filter((value): value is string => Boolean(value)).sort().at(-1)
    ?? null;

  return {
    organisation: organisationSummary,
    hierarchy,
    kpis,
    connect: {
      connectors,
      recentRuns,
      pipelineCount: connectors.reduce((total, connector) => total + connector.pipelineCount, 0),
      failedRuns: recentRuns.filter((run) => run.status === "failed").length,
      warningRuns: recentRuns.filter((run) => run.status === "warning").length,
      recentRowsAccepted: recentRuns.reduce((total, run) => total + run.rowsAccepted, 0),
      latestRunAt,
    },
  };
}
