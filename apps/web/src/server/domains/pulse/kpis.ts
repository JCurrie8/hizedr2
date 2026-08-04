import type { PoolClient } from "@neondatabase/serverless";
import type { AppRole, OrgNodeType } from "@hized/contracts";

export type KpiUnit = "number" | "percentage" | "currency" | "duration" | "score";
export type KpiDirection = "higher" | "lower" | "target";
export type KpiThresholdState = "green" | "amber" | "red" | "no_threshold";
export type KpiTrendDirection = "improving" | "deteriorating" | "flat" | "no_comparison";

export interface PulseKpiTrendPoint {
  periodEnd: string | null;
  label: string;
  actualValue: number;
}

export interface PulseHierarchyNode {
  id: string;
  name: string;
  nodeType: OrgNodeType;
}

export interface PulseHierarchy {
  selected: PulseHierarchyNode;
  breadcrumbs: PulseHierarchyNode[];
  children: PulseHierarchyNode[];
}

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
  thresholds: Record<string, unknown>;
  actualValue: number;
  targetValue: number | null;
  priorPeriodValue: number | null;
  periodStart: string;
  periodEnd: string;
  organisation: { id: string; name: string };
  trend: PulseKpiTrendPoint[];
  freshness: {
    sourceRefreshedAt: string;
    expectedLatencySeconds: number;
    status: "fresh" | "stale";
  };
}

function parseHierarchyNode(value: unknown): PulseHierarchyNode {
  const node = value as { id: string; name: string; nodeType: OrgNodeType };
  return { id: node.id, name: node.name, nodeType: node.nodeType };
}

/**
 * Resolves a requested drill target through ordinary RLS-protected hierarchy
 * rows. An inaccessible/cross-tenant ID produces no candidate row and falls
 * back to the member's primary scope (or the company root for Company Admins).
 */
export async function getPulseHierarchy(
  client: PoolClient,
  input: { tenantId: string; requestedOrgNodeId?: string | null },
): Promise<PulseHierarchy | null> {
  const { rows: [row] } = await client.query(
    `with default_scope as (
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
     ), selected as (
       select node.id, node.node_type, version.name, version.path
       from public.org_nodes node
       join public.org_node_versions version
         on version.org_node_id = node.id and version.tenant_id = node.tenant_id
       where node.tenant_id = $1
         and node.id = coalesce(
           (
             select requested.org_node_id
             from public.org_node_versions requested
             where requested.tenant_id = $1
               and requested.org_node_id = $2::uuid
               and requested.valid_from <= current_date
               and (requested.valid_to is null or requested.valid_to > current_date)
             limit 1
           ),
           (select org_node_id from default_scope)
         )
         and version.valid_from <= current_date
         and (version.valid_to is null or version.valid_to > current_date)
       limit 1
     )
     select
       jsonb_build_object('id', selected.id, 'name', selected.name, 'nodeType', selected.node_type) as selected,
       coalesce((
         select jsonb_agg(
           jsonb_build_object('id', ancestor.id, 'name', ancestor_version.name, 'nodeType', ancestor.node_type)
           order by public.nlevel(ancestor_version.path)
         )
         from public.org_nodes ancestor
         join public.org_node_versions ancestor_version
           on ancestor_version.org_node_id = ancestor.id and ancestor_version.tenant_id = ancestor.tenant_id
         where ancestor.tenant_id = $1
           and ancestor_version.path OPERATOR(public.@>) selected.path
           and ancestor_version.valid_from <= current_date
           and (ancestor_version.valid_to is null or ancestor_version.valid_to > current_date)
       ), '[]'::jsonb) as breadcrumbs,
       coalesce((
         select jsonb_agg(
           jsonb_build_object('id', child.id, 'name', child_version.name, 'nodeType', child.node_type)
           order by child_version.name, child.id
         )
         from public.org_nodes child
         join public.org_node_versions child_version
           on child_version.org_node_id = child.id and child_version.tenant_id = child.tenant_id
         where child.tenant_id = $1
           and child_version.parent_id = selected.id
           and child_version.valid_from <= current_date
           and (child_version.valid_to is null or child_version.valid_to > current_date)
       ), '[]'::jsonb) as children
     from selected`,
    [input.tenantId, input.requestedOrgNodeId ?? null],
  );
  if (!row) return null;
  return {
    selected: parseHierarchyNode(row.selected),
    breadcrumbs: (row.breadcrumbs as unknown[]).map(parseHierarchyNode),
    children: (row.children as unknown[]).map(parseHierarchyNode),
  };
}

export interface KpiCatalogueEntry {
  id: string;
  key: string;
  version: number;
  name: string;
  definition: string;
  businessPurpose: string;
  formulaReference: string;
  ownerName: string;
  reviewerName: string;
  unit: KpiUnit;
  currencyCode: string | null;
  decimalPlaces: number;
  favourableDirection: KpiDirection;
  aggregation: string;
  targetMethod: string;
  thresholds: Record<string, unknown>;
  permittedDimensions: string[];
  applicableNodeTypes: string[];
  audienceRoles: AppRole[];
  refreshCadence: string;
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
       definition.business_purpose,
       definition.formula_reference,
       definition.owner_name,
       definition.reviewer_name,
       definition.unit,
       definition.currency_code,
       definition.decimal_places,
       definition.favourable_direction,
       definition.aggregation,
       definition.target_method,
       definition.thresholds,
       definition.permitted_dimensions,
       definition.applicable_node_types,
       definition.audience_roles,
       definition.refresh_cadence as definition_refresh_cadence,
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
    businessPurpose: row.business_purpose,
    formulaReference: row.formula_reference,
    ownerName: row.owner_name,
    reviewerName: row.reviewer_name,
    unit: row.unit,
    currencyCode: row.currency_code,
    decimalPlaces: Number(row.decimal_places),
    favourableDirection: row.favourable_direction,
    aggregation: row.aggregation,
    targetMethod: row.target_method,
    thresholds: row.thresholds,
    permittedDimensions: row.permitted_dimensions,
    applicableNodeTypes: row.applicable_node_types,
    audienceRoles: row.audience_roles,
    refreshCadence: row.definition_refresh_cadence,
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
  input: { tenantId: string; orgNodeId?: string | null },
): Promise<PulseKpiCard[]> {
  const { rows } = await client.query(
    `with default_scope as (
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
     ), display_scope as (
       select coalesce(
         (
           select version.org_node_id
           from public.org_node_versions version
           where version.tenant_id = $1
             and version.org_node_id = $2::uuid
             and version.valid_from <= current_date
             and (version.valid_to is null or version.valid_to > current_date)
           limit 1
         ),
         (select org_node_id from default_scope)
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
         definition.thresholds,
         value.actual_value,
         value.target_value,
         value.prior_period_value,
         value.period_start::text as period_start,
         value.period_end::text as period_end,
         extract(epoch from value.source_refreshed_at) as source_refreshed_epoch,
         extract(epoch from dataset.expected_latency)::integer as expected_latency_seconds,
         node.id as organisation_id,
         version.name as organisation_name,
         trend.points as trend_points,
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
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'periodEnd', history.period_end::text,
             'actualValue', history.actual_value
           ) order by history.period_end
         ) as points
         from (
           select historical.period_end, historical.actual_value
           from public.kpi_values historical
           where historical.tenant_id = $1
             and historical.kpi_definition_id = definition.id
             and historical.org_node_id = scope.org_node_id
           order by historical.period_end desc, historical.calculated_at desc
           limit 6
         ) history
       ) trend on true
       where value.tenant_id = $1
         and definition.approval_status = 'approved'
         and definition.valid_from <= value.period_end
         and (definition.valid_to is null or definition.valid_to > value.period_end)
     )
     select * from ranked where recency_rank = 1 order by name, kpi_key`,
    [input.tenantId, input.orgNodeId ?? null],
  );

  return rows.map((row) => {
    const sourceRefreshedAt = new Date(Number(row.source_refreshed_epoch) * 1_000).toISOString();
    const expectedLatencySeconds = Number(row.expected_latency_seconds);
    const staleAfter = new Date(sourceRefreshedAt).getTime() + expectedLatencySeconds * 1_000;
    const storedTrend = ((row.trend_points ?? []) as Array<{ periodEnd: string; actualValue: string | number }>).map((point) => ({
      periodEnd: String(point.periodEnd),
      label: String(point.periodEnd),
      actualValue: Number(point.actualValue),
    }));
    const priorPeriodValue = row.prior_period_value === null ? null : Number(row.prior_period_value);
    const trend = storedTrend.length === 1 && priorPeriodValue !== null
      ? [{ periodEnd: null, label: "Prior period", actualValue: priorPeriodValue }, ...storedTrend]
      : storedTrend;
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
      thresholds: row.thresholds,
      actualValue: Number(row.actual_value),
      targetValue: row.target_value === null ? null : Number(row.target_value),
      priorPeriodValue,
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      organisation: { id: row.organisation_id, name: row.organisation_name },
      trend,
      freshness: {
        sourceRefreshedAt,
        expectedLatencySeconds,
        status: staleAfter < Date.now() ? "stale" : "fresh",
      },
    } satisfies PulseKpiCard;
  });
}

function thresholdNumber(thresholds: Record<string, unknown>, band: "green" | "amber", key: "gte" | "lte" | "within"): number | null {
  const candidate = thresholds[band];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = (candidate as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function thresholdState(
  kpi: Pick<PulseKpiCard, "actualValue" | "targetValue" | "favourableDirection" | "thresholds">,
): KpiThresholdState {
  if (kpi.favourableDirection === "higher") {
    const green = thresholdNumber(kpi.thresholds, "green", "gte");
    const amber = thresholdNumber(kpi.thresholds, "amber", "gte");
    if (green === null || amber === null) return kpi.targetValue === null ? "no_threshold" : targetState(kpi) === "on_track" ? "green" : "red";
    return kpi.actualValue >= green ? "green" : kpi.actualValue >= amber ? "amber" : "red";
  }
  if (kpi.favourableDirection === "lower") {
    const green = thresholdNumber(kpi.thresholds, "green", "lte");
    const amber = thresholdNumber(kpi.thresholds, "amber", "lte");
    if (green === null || amber === null) return kpi.targetValue === null ? "no_threshold" : targetState(kpi) === "on_track" ? "green" : "red";
    return kpi.actualValue <= green ? "green" : kpi.actualValue <= amber ? "amber" : "red";
  }
  const green = thresholdNumber(kpi.thresholds, "green", "within");
  const amber = thresholdNumber(kpi.thresholds, "amber", "within");
  if (kpi.targetValue === null || green === null || amber === null) return kpi.targetValue === null ? "no_threshold" : targetState(kpi) === "on_track" ? "green" : "red";
  const variance = Math.abs(kpi.actualValue - kpi.targetValue);
  return variance <= green ? "green" : variance <= amber ? "amber" : "red";
}

export function trendDirection(
  kpi: Pick<PulseKpiCard, "actualValue" | "priorPeriodValue" | "targetValue" | "favourableDirection">,
): KpiTrendDirection {
  if (kpi.priorPeriodValue === null) return "no_comparison";
  if (kpi.actualValue === kpi.priorPeriodValue) return "flat";
  if (kpi.favourableDirection === "higher") return kpi.actualValue > kpi.priorPeriodValue ? "improving" : "deteriorating";
  if (kpi.favourableDirection === "lower") return kpi.actualValue < kpi.priorPeriodValue ? "improving" : "deteriorating";
  if (kpi.targetValue === null) return "no_comparison";
  const currentDistance = Math.abs(kpi.actualValue - kpi.targetValue);
  const priorDistance = Math.abs(kpi.priorPeriodValue - kpi.targetValue);
  return currentDistance === priorDistance ? "flat" : currentDistance < priorDistance ? "improving" : "deteriorating";
}

export function targetState(kpi: Pick<PulseKpiCard, "actualValue" | "targetValue" | "favourableDirection">) {
  if (kpi.targetValue === null) return "no_target" as const;
  if (kpi.favourableDirection === "higher") return kpi.actualValue >= kpi.targetValue ? "on_track" as const : "off_track" as const;
  if (kpi.favourableDirection === "lower") return kpi.actualValue <= kpi.targetValue ? "on_track" as const : "off_track" as const;
  return kpi.actualValue === kpi.targetValue ? "on_track" as const : "off_track" as const;
}
