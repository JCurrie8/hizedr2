import type { AppRole } from "@hized/contracts";
import type { PoolClient } from "@neondatabase/serverless";
import type { KpiDirection, KpiUnit } from "./kpis";

export const KPI_AGGREGATIONS = ["sum", "average", "distinct_count", "ratio", "snapshot", "semi_additive"] as const;
export type KpiAggregation = typeof KPI_AGGREGATIONS[number];
export const KPI_TARGET_METHODS = ["fixed", "period_specific", "inherited", "employee_specific"] as const;
export type KpiTargetMethod = typeof KPI_TARGET_METHODS[number];
export const KPI_NODE_TYPES = ["company", "division", "function", "department", "region", "site", "team", "employee"] as const;
export type KpiNodeType = typeof KPI_NODE_TYPES[number];

export interface GovernedDatasetOption {
  id: string;
  name: string;
  subjectArea: string;
  refreshCadence: string;
}

export const DIMENSION_SEMANTIC_TYPES = ["product", "customer", "geography", "organisation", "custom"] as const;
export type DimensionSemanticType = typeof DIMENSION_SEMANTIC_TYPES[number];

export interface GovernedDimensionOption {
  id: string;
  key: string;
  name: string;
  semanticType: DimensionSemanticType;
  members: Array<{ key: string; label: string }>;
}

export interface KpiDraftInput {
  tenantId: string;
  datasetId: string;
  key: string;
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
  aggregation: KpiAggregation;
  refreshCadence: string;
  thresholds: Record<string, unknown>;
  targetMethod: KpiTargetMethod;
  permittedDimensions: readonly string[];
  applicableNodeTypes: readonly KpiNodeType[];
  audienceRoles: readonly AppRole[];
  validFrom: string;
  createdBy: string;
}

export async function listPublishedDatasetOptions(
  client: PoolClient,
  input: { tenantId: string },
): Promise<GovernedDatasetOption[]> {
  const { rows } = await client.query(
    `select id, name, subject_area, refresh_cadence
     from public.governed_datasets
     where tenant_id = $1 and status = 'published'
     order by subject_area, name`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    subjectArea: row.subject_area,
    refreshCadence: row.refresh_cadence,
  }));
}

export async function listGovernedDimensionOptions(
  client: PoolClient,
  input: { tenantId: string },
): Promise<GovernedDimensionOption[]> {
  const { rows } = await client.query(
    `select dimension.id, dimension.dimension_key, dimension.name, dimension.semantic_type,
            member.member_key, member.label
       from public.governed_dimensions dimension
       left join public.governed_dimension_members member
         on member.dimension_id = dimension.id
        and member.tenant_id = dimension.tenant_id
        and member.is_active
      where dimension.tenant_id = $1 and dimension.status = 'published'
      order by dimension.name, member.sort_order, member.label`,
    [input.tenantId],
  );
  const byId = new Map<string, GovernedDimensionOption>();
  for (const row of rows) {
    let dimension = byId.get(row.id);
    if (!dimension) {
      dimension = {
        id: row.id,
        key: row.dimension_key,
        name: row.name,
        semanticType: row.semantic_type,
        members: [],
      };
      byId.set(row.id, dimension);
    }
    if (row.member_key) dimension.members.push({ key: row.member_key, label: row.label });
  }
  return [...byId.values()];
}

export async function createGovernedDimension(
  client: PoolClient,
  input: {
    tenantId: string;
    key: string;
    name: string;
    description: string;
    semanticType: DimensionSemanticType;
    members: Array<{ key: string; label: string }>;
    actorUserId: string;
  },
): Promise<string> {
  const { rows: [created] } = await client.query(
    `insert into public.governed_dimensions
       (tenant_id, dimension_key, name, description, semantic_type, status, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'published', $6, $6)
     returning id`,
    [input.tenantId, input.key, input.name, input.description, input.semanticType, input.actorUserId],
  );
  await client.query(
    `insert into public.governed_dimension_members
       (tenant_id, dimension_id, member_key, label, sort_order)
     select $1, $2, member_key, label, ordinal - 1
       from unnest($3::text[], $4::text[]) with ordinality as member(member_key, label, ordinal)`,
    [input.tenantId, created.id, input.members.map((member) => member.key), input.members.map((member) => member.label)],
  );
  return created.id;
}

async function syncKpiDimensionLinks(
  client: PoolClient,
  input: { tenantId: string; definitionId: string; dimensionKeys: readonly string[] },
): Promise<void> {
  const uniqueKeys = [...new Set(input.dimensionKeys)];
  const { rows } = uniqueKeys.length === 0 ? { rows: [] } : await client.query(
    `select id, dimension_key
       from public.governed_dimensions
      where tenant_id = $1 and status = 'published' and dimension_key = any($2::text[])`,
    [input.tenantId, uniqueKeys],
  );
  if (rows.length !== uniqueKeys.length) throw new Error("Choose only published governed dimensions.");
  await client.query(
    `delete from public.kpi_definition_dimensions
      where tenant_id = $1 and kpi_definition_id = $2`,
    [input.tenantId, input.definitionId],
  );
  if (rows.length > 0) {
    await client.query(
      `insert into public.kpi_definition_dimensions
         (tenant_id, kpi_definition_id, dimension_id, is_filterable, is_drillable)
       select $1, $2, selected.id, true, true
         from unnest($3::uuid[]) with ordinality selected(id, position)
        order by selected.position`,
      [input.tenantId, input.definitionId, rows
        .sort((left, right) => uniqueKeys.indexOf(left.dimension_key) - uniqueKeys.indexOf(right.dimension_key))
        .map((row) => row.id)],
    );
  }
}

async function lockKpiKey(client: PoolClient, tenantId: string, key: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenantId}:${key}`]);
}

export async function createKpiDraft(client: PoolClient, input: KpiDraftInput): Promise<{ id: string; version: number }> {
  await lockKpiKey(client, input.tenantId, input.key);
  const { rows: [version] } = await client.query(
    `select coalesce(max(version_number), 0)::integer + 1 as next_version
     from public.kpi_definitions
     where tenant_id = $1 and kpi_key = $2`,
    [input.tenantId, input.key],
  );
  const nextVersion = Number(version.next_version);
  const { rows: [created] } = await client.query(
    `insert into public.kpi_definitions
       (tenant_id, dataset_id, kpi_key, version_number, name, definition,
        business_purpose, formula_reference, owner_name, reviewer_name, unit,
        currency_code, decimal_places, favourable_direction, aggregation,
        refresh_cadence, thresholds, target_method, permitted_dimensions,
        applicable_node_types, audience_roles, valid_from, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23)
     returning id`,
    [
      input.tenantId, input.datasetId, input.key, nextVersion, input.name,
      input.definition, input.businessPurpose, input.formulaReference,
      input.ownerName, input.reviewerName, input.unit, input.currencyCode,
      input.decimalPlaces, input.favourableDirection, input.aggregation,
      input.refreshCadence, JSON.stringify(input.thresholds), input.targetMethod,
      input.permittedDimensions, input.applicableNodeTypes, input.audienceRoles,
      input.validFrom, input.createdBy,
    ],
  );
  await syncKpiDimensionLinks(client, {
    tenantId: input.tenantId,
    definitionId: created.id,
    dimensionKeys: input.permittedDimensions,
  });
  return { id: created.id, version: nextVersion };
}

export async function updateKpiDraft(
  client: PoolClient,
  input: Omit<KpiDraftInput, "key" | "createdBy"> & { definitionId: string },
): Promise<void> {
  const result = await client.query(
    `update public.kpi_definitions
     set dataset_id = $3,
         name = $4,
         definition = $5,
         business_purpose = $6,
         formula_reference = $7,
         owner_name = $8,
         reviewer_name = $9,
         unit = $10,
         currency_code = $11,
         decimal_places = $12,
         favourable_direction = $13,
         aggregation = $14,
         refresh_cadence = $15,
         thresholds = $16::jsonb,
         target_method = $17,
         permitted_dimensions = $18,
         applicable_node_types = $19,
         audience_roles = $20,
         valid_from = $21
     where tenant_id = $1 and id = $2 and approval_status = 'draft'`,
    [
      input.tenantId, input.definitionId, input.datasetId, input.name,
      input.definition, input.businessPurpose, input.formulaReference,
      input.ownerName, input.reviewerName, input.unit, input.currencyCode,
      input.decimalPlaces, input.favourableDirection, input.aggregation,
      input.refreshCadence, JSON.stringify(input.thresholds), input.targetMethod,
      input.permittedDimensions, input.applicableNodeTypes, input.audienceRoles,
      input.validFrom,
    ],
  );
  if (result.rowCount !== 1) throw new Error("KPI draft not found or no longer editable.");
  await syncKpiDimensionLinks(client, {
    tenantId: input.tenantId,
    definitionId: input.definitionId,
    dimensionKeys: input.permittedDimensions,
  });
}

export async function createNextKpiVersion(
  client: PoolClient,
  input: { tenantId: string; definitionId: string; validFrom: string; createdBy: string },
): Promise<{ id: string; version: number }> {
  const { rows: [current] } = await client.query(
    `select * from public.kpi_definitions
     where tenant_id = $1 and id = $2 and approval_status = 'approved' and valid_to is null`,
    [input.tenantId, input.definitionId],
  );
  if (!current) throw new Error("Current approved KPI definition not found.");
  return createKpiDraft(client, {
    tenantId: input.tenantId,
    datasetId: current.dataset_id,
    key: current.kpi_key,
    name: current.name,
    definition: current.definition,
    businessPurpose: current.business_purpose,
    formulaReference: current.formula_reference,
    ownerName: current.owner_name,
    reviewerName: current.reviewer_name,
    unit: current.unit,
    currencyCode: current.currency_code,
    decimalPlaces: Number(current.decimal_places),
    favourableDirection: current.favourable_direction,
    aggregation: current.aggregation,
    refreshCadence: current.refresh_cadence,
    thresholds: current.thresholds,
    targetMethod: current.target_method,
    permittedDimensions: current.permitted_dimensions,
    applicableNodeTypes: current.applicable_node_types,
    audienceRoles: current.audience_roles,
    validFrom: input.validFrom,
    createdBy: input.createdBy,
  });
}

export async function approveKpiDraft(
  client: PoolClient,
  input: { tenantId: string; definitionId: string },
): Promise<void> {
  await client.query("select public.approve_kpi_definition_version($1, $2)", [input.tenantId, input.definitionId]);
}

export async function rejectKpiDraft(
  client: PoolClient,
  input: { tenantId: string; definitionId: string },
): Promise<void> {
  const result = await client.query(
    `update public.kpi_definitions
     set approval_status = 'rejected'
     where tenant_id = $1 and id = $2 and approval_status = 'draft'`,
    [input.tenantId, input.definitionId],
  );
  if (result.rowCount !== 1) throw new Error("KPI draft not found or cannot be rejected.");
}
