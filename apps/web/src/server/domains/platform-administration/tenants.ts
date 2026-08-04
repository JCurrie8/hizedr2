import type { PoolClient } from "@neondatabase/serverless";
import {
  PRODUCT_KEYS,
  type ProductEntitlement,
  type ProductEntitlementStatus,
  type ProductKey,
} from "../products/entitlements";

export const MANAGEABLE_TENANT_STATUSES = ["active", "suspended"] as const;
export type ManageableTenantStatus = (typeof MANAGEABLE_TENANT_STATUSES)[number];

export interface PlatformTenantSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  timezone: string;
  createdAt: string;
  activeMembers: number;
  pendingInvitations: number;
}

export interface PlatformTenantDetail {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    timezone: string;
    financialCalendarStartMonth: number;
    dataRetentionDays: number | null;
    createdAt: string;
    updatedAt: string;
  };
  entitlements: ProductEntitlement[];
  companyAdmins: Array<{
    membershipId: string;
    name: string | null;
    email: string;
    status: string;
  }>;
  counts: {
    activeMembers: number;
    pendingInvitations: number;
    currentOrgNodes: number;
    connectors: number;
    publishedDatasets: number;
    approvedKpis: number;
    publishedViews: number;
  };
}

export function isProductKey(value: string): value is ProductKey {
  return PRODUCT_KEYS.includes(value as ProductKey);
}

export function isEntitlementStatus(value: string): value is ProductEntitlementStatus {
  return value === "active" || value === "trial" || value === "locked";
}

export function isManageableTenantStatus(value: string): value is ManageableTenantStatus {
  return MANAGEABLE_TENANT_STATUSES.includes(value as ManageableTenantStatus);
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format();
  } catch {
    throw new Error("Choose a valid IANA time zone, for example Europe/London.");
  }
}

export async function listPlatformTenants(client: PoolClient): Promise<PlatformTenantSummary[]> {
  const { rows } = await client.query<{
    id: string;
    slug: string;
    name: string;
    status: string;
    timezone: string;
    created_at: string;
    active_members: number;
    pending_invitations: number;
  }>(
    `select t.id, t.slug, t.name, t.status, t.timezone, t.created_at,
            (select count(*)::integer from public.tenant_memberships m
             where m.tenant_id = t.id and m.status = 'active') as active_members,
            (select count(*)::integer from public.invitations i
             where i.tenant_id = t.id and i.status = 'pending' and i.expires_at > now()) as pending_invitations
     from public.tenants t
     order by t.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    createdAt: row.created_at,
    activeMembers: row.active_members,
    pendingInvitations: row.pending_invitations,
  }));
}

export async function getPlatformTenantDetail(
  client: PoolClient,
  tenantId: string,
): Promise<PlatformTenantDetail | null> {
  const { rows: tenants } = await client.query<{
    id: string;
    slug: string;
    name: string;
    status: string;
    timezone: string;
    financial_calendar_start_month: number;
    data_retention_days: number | null;
    created_at: string;
    updated_at: string;
    active_members: number;
    pending_invitations: number;
    current_org_nodes: number;
    connectors: number;
    published_datasets: number;
    approved_kpis: number;
    published_views: number;
  }>(
    `select t.*,
            (select count(*)::integer from public.tenant_memberships m
             where m.tenant_id = t.id and m.status = 'active') as active_members,
            (select count(*)::integer from public.invitations i
             where i.tenant_id = t.id and i.status = 'pending' and i.expires_at > now()) as pending_invitations,
            (select count(*)::integer from public.org_node_versions v
             where v.tenant_id = t.id and v.valid_from <= current_date
               and (v.valid_to is null or v.valid_to > current_date)) as current_org_nodes,
            (select count(*)::integer from public.connectors c where c.tenant_id = t.id) as connectors,
            (select count(*)::integer from public.governed_datasets d
             where d.tenant_id = t.id and d.status = 'published') as published_datasets,
            (select count(*)::integer from public.kpi_definitions k
             where k.tenant_id = t.id and k.approval_status = 'approved') as approved_kpis,
            (select count(*)::integer from public.analytics_views v
             where v.tenant_id = t.id and v.status = 'published') as published_views
     from public.tenants t
     where t.id = $1`,
    [tenantId],
  );
  const row = tenants[0];
  if (!row) return null;

  const entitlementResult = await client.query<{ product_key: ProductKey; status: ProductEntitlementStatus }>(
      `select product_key, status from public.tenant_product_entitlements
       where tenant_id = $1 order by product_key`,
      [tenantId],
    );
  const adminResult = await client.query<{ membership_id: string; name: string | null; email: string; status: string }>(
      `select m.id as membership_id, p.full_name as name, u.email, m.status
       from public.tenant_memberships m
       join public.profiles p on p.id = m.user_id
       join public."user" u on u.id = p.auth_user_id
       where m.tenant_id = $1 and m.role = 'company_admin'
       order by (m.status = 'active') desc, coalesce(p.full_name, u.email)`,
      [tenantId],
    );

  return {
    tenant: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
      financialCalendarStartMonth: row.financial_calendar_start_month,
      dataRetentionDays: row.data_retention_days,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    entitlements: entitlementResult.rows.map((item) => ({
      productKey: item.product_key,
      status: item.status,
    })),
    companyAdmins: adminResult.rows.map((admin) => ({
      membershipId: admin.membership_id,
      name: admin.name,
      email: admin.email,
      status: admin.status,
    })),
    counts: {
      activeMembers: row.active_members,
      pendingInvitations: row.pending_invitations,
      currentOrgNodes: row.current_org_nodes,
      connectors: row.connectors,
      publishedDatasets: row.published_datasets,
      approvedKpis: row.approved_kpis,
      publishedViews: row.published_views,
    },
  };
}

export async function updateTenantConfiguration(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    timezone: string;
    financialCalendarStartMonth: number;
    dataRetentionDays: number | null;
  },
) {
  if (!input.name.trim()) throw new Error("Tenant name is required.");
  assertValidTimezone(input.timezone);
  if (!Number.isInteger(input.financialCalendarStartMonth)
    || input.financialCalendarStartMonth < 1
    || input.financialCalendarStartMonth > 12) {
    throw new Error("Financial year start month must be between 1 and 12.");
  }
  if (input.dataRetentionDays !== null
    && (!Number.isInteger(input.dataRetentionDays) || input.dataRetentionDays < 30 || input.dataRetentionDays > 3650)) {
    throw new Error("Retention must be between 30 and 3650 days, or left blank.");
  }

  const { rows: [updated] } = await client.query<{
    id: string;
    name: string;
    timezone: string;
    financial_calendar_start_month: number;
    data_retention_days: number | null;
  }>(
    `update public.tenants
     set name = $2, timezone = $3, financial_calendar_start_month = $4,
         data_retention_days = $5, updated_at = now()
     where id = $1
     returning id, name, timezone, financial_calendar_start_month, data_retention_days`,
    [input.tenantId, input.name.trim(), input.timezone, input.financialCalendarStartMonth, input.dataRetentionDays],
  );
  if (!updated) throw new Error("Tenant not found.");
  return updated;
}

export async function updateProductEntitlement(
  client: PoolClient,
  input: { tenantId: string; productKey: ProductKey; status: ProductEntitlementStatus; actorUserId: string },
) {
  const { rows: [previous] } = await client.query<{ status: ProductEntitlementStatus }>(
    `select status from public.tenant_product_entitlements where tenant_id = $1 and product_key = $2`,
    [input.tenantId, input.productKey],
  );
  if (!previous) throw new Error("Product entitlement not found.");
  await client.query(
    `update public.tenant_product_entitlements
     set status = $3, changed_by = $4, changed_at = now()
     where tenant_id = $1 and product_key = $2`,
    [input.tenantId, input.productKey, input.status, input.actorUserId],
  );
  return { previousStatus: previous.status, status: input.status };
}

export async function updateTenantStatus(
  client: PoolClient,
  input: { tenantId: string; status: ManageableTenantStatus },
) {
  const { rows: [previous] } = await client.query<{ status: string }>(
    "select status from public.tenants where id = $1 for update",
    [input.tenantId],
  );
  if (!previous) throw new Error("Tenant not found.");
  if (previous.status === "offboarding" || previous.status === "deleted") {
    throw new Error("Offboarding state cannot be changed from this control.");
  }
  await client.query("update public.tenants set status = $2, updated_at = now() where id = $1", [
    input.tenantId,
    input.status,
  ]);
  return { previousStatus: previous.status, status: input.status };
}
