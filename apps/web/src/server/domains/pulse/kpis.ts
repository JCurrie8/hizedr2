import type { PoolClient } from "@neondatabase/serverless";

export type KpiUnit = "number" | "percentage" | "currency" | "duration" | "score";
export type KpiDirection = "higher" | "lower" | "target";

export interface PulseKpiCard {
  definitionId: string;
  key: string;
  name: string;
  definition: string;
  ownerName: string;
  unit: KpiUnit;
  currencyCode: string | null;
  decimalPlaces: number;
  favourableDirection: KpiDirection;
  actualValue: number;
  targetValue: number | null;
  priorPeriodValue: number | null;
  periodStart: string;
  periodEnd: string;
  organisation: { id: string; name: string };
  freshness: {
    sourceRefreshedAt: string;
    expectedLatencySeconds: number;
    status: "fresh" | "stale";
  };
}

export interface KpiCatalogueEntry {
  id: string;
  key: string;
  version: number;
  name: string;
  definition: string;
  formulaReference: string;
  ownerName: string;
  unit: KpiUnit;
  currencyCode: string | null;
  favourableDirection: KpiDirection;
  approvalStatus: "draft" | "approved" | "rejected";
  validFrom: string;
  validTo: string | null;
  dataset: {
    id: string;
    name: string;
    subjectArea: string;
    status: "draft" | "published" | "retired";
    refreshCadence: string;
  };
}

export async function listKpiCatalogue(
  client: PoolClient,
  input: { tenantId: string },
): Promise<KpiCatalogueEntry[]> {
  const { rows } = await client.query(
    `select
       definition.id,
       definition.kpi_key,
       definition.version_number,
       definition.name,
       definition.definition,
       definition.formula_reference,
       definition.owner_name,
       definition.unit,
       definition.currency_code,
       definition.favourable_direction,
       definition.approval_status,
       definition.valid_from,
       definition.valid_to,
       dataset.id as dataset_id,
       dataset.name as dataset_name,
       dataset.subject_area,
       dataset.status as dataset_status,
       dataset.refresh_cadence
     from public.kpi_definitions definition
     join public.governed_datasets dataset
       on dataset.id = definition.dataset_id
      and dataset.tenant_id = definition.tenant_id
     where definition.tenant_id = $1
     order by definition.name, definition.version_number desc`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    key: row.kpi_key,
    version: Number(row.version_number),
    name: row.name,
    definition: row.definition,
    formulaReference: row.formula_reference,
    ownerName: row.owner_name,
    unit: row.unit,
    currencyCode: row.currency_code,
    favourableDirection: row.favourable_direction,
    approvalStatus: row.approval_status,
    validFrom: String(row.valid_from),
    validTo: row.valid_to === null ? null : String(row.valid_to),
    dataset: {
      id: row.dataset_id,
      name: row.dataset_name,
      subjectArea: row.subject_area,
      status: row.dataset_status,
      refreshCadence: row.refresh_cadence,
    },
  }));
}

/**
 * Returns the most recent approved KPI value at the member's primary scope.
 * Company Admins have no assigned scope, so their landing level is the company
 * root. RLS independently filters definition audience and hierarchy rows.
 */
export async function listPulseKpiCards(
  client: PoolClient,
  input: { tenantId: string },
): Promise<PulseKpiCard[]> {
  const { rows } = await client.query(
    `with display_scope as (
       select coalesce(
         (
           select scope.org_node_id
           from public.tenant_memberships membership
           join public.membership_scopes scope
             on scope.membership_id = membership.id and scope.is_primary
           where membership.tenant_id = $1
             and membership.user_id = public.current_user_id()
             and membership.status = 'active'
           limit 1
         ),
         (
           select node.id
           from public.org_nodes node
           where node.tenant_id = $1 and node.node_type = 'company'
           order by node.created_at, node.id
           limit 1
         )
       ) as org_node_id
     ), ranked as (
       select
         definition.id as definition_id,
         definition.kpi_key,
         definition.name,
         definition.definition,
         definition.owner_name,
         definition.unit,
         definition.currency_code,
         definition.decimal_places,
         definition.favourable_direction,
         value.actual_value,
         value.target_value,
         value.prior_period_value,
         value.period_start::text as period_start,
         value.period_end::text as period_end,
         extract(epoch from value.source_refreshed_at) as source_refreshed_epoch,
         extract(epoch from dataset.expected_latency)::integer as expected_latency_seconds,
         node.id as organisation_id,
         version.name as organisation_name,
         row_number() over (
           partition by definition.kpi_key
           order by value.period_end desc, definition.version_number desc, value.calculated_at desc
         ) as recency_rank
       from display_scope scope
       join public.kpi_values value on value.org_node_id = scope.org_node_id
       join public.kpi_definitions definition
         on definition.id = value.kpi_definition_id
        and definition.tenant_id = value.tenant_id
       join public.governed_datasets dataset
         on dataset.id = definition.dataset_id
        and dataset.tenant_id = definition.tenant_id
       join public.org_nodes node
         on node.id = value.org_node_id
        and node.tenant_id = value.tenant_id
       join public.org_node_versions version
         on version.org_node_id = node.id
        and version.tenant_id = node.tenant_id
        and version.valid_from <= current_date
        and (version.valid_to is null or version.valid_to > current_date)
       where value.tenant_id = $1
         and definition.approval_status = 'approved'
         and definition.valid_from <= value.period_end
         and (definition.valid_to is null or definition.valid_to > value.period_end)
     )
     select * from ranked where recency_rank = 1 order by name, kpi_key`,
    [input.tenantId],
  );

  return rows.map((row) => {
    const sourceRefreshedAt = new Date(Number(row.source_refreshed_epoch) * 1_000).toISOString();
    const expectedLatencySeconds = Number(row.expected_latency_seconds);
    const staleAfter = new Date(sourceRefreshedAt).getTime() + expectedLatencySeconds * 1_000;
    return {
      definitionId: row.definition_id,
      key: row.kpi_key,
      name: row.name,
      definition: row.definition,
      ownerName: row.owner_name,
      unit: row.unit,
      currencyCode: row.currency_code,
      decimalPlaces: Number(row.decimal_places),
      favourableDirection: row.favourable_direction,
      actualValue: Number(row.actual_value),
      targetValue: row.target_value === null ? null : Number(row.target_value),
      priorPeriodValue: row.prior_period_value === null ? null : Number(row.prior_period_value),
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      organisation: { id: row.organisation_id, name: row.organisation_name },
      freshness: {
        sourceRefreshedAt,
        expectedLatencySeconds,
        status: staleAfter < Date.now() ? "stale" : "fresh",
      },
    } satisfies PulseKpiCard;
  });
}

export function targetState(kpi: Pick<PulseKpiCard, "actualValue" | "targetValue" | "favourableDirection">) {
  if (kpi.targetValue === null) return "no_target" as const;
  if (kpi.favourableDirection === "higher") return kpi.actualValue >= kpi.targetValue ? "on_track" as const : "off_track" as const;
  if (kpi.favourableDirection === "lower") return kpi.actualValue <= kpi.targetValue ? "on_track" as const : "off_track" as const;
  return kpi.actualValue === kpi.targetValue ? "on_track" as const : "off_track" as const;
}
