import type { PoolClient } from "@neondatabase/serverless";

export const PRODUCT_KEYS = ["pulse", "connect", "canvas"] as const;

export type ProductKey = (typeof PRODUCT_KEYS)[number];
export type ProductEntitlementStatus = "active" | "trial" | "locked";

export interface ProductEntitlement {
  productKey: ProductKey;
  status: ProductEntitlementStatus;
}

interface ProductEntitlementRow {
  product_key: ProductKey;
  status: ProductEntitlementStatus;
}

export async function listProductEntitlements(
  client: PoolClient,
  input: { tenantId: string },
): Promise<ProductEntitlement[]> {
  const { rows } = await client.query<ProductEntitlementRow>(
    `select product_key, status
     from public.tenant_product_entitlements
     where tenant_id = $1
     order by product_key`,
    [input.tenantId],
  );
  return rows.map((row) => ({ productKey: row.product_key, status: row.status }));
}

export async function hasProductAccess(
  client: PoolClient,
  input: { tenantId: string; productKey: ProductKey },
): Promise<boolean> {
  const { rows: [row] } = await client.query<{ allowed: boolean }>(
    `select exists (
       select 1
       from public.tenant_product_entitlements
       join public.tenants on tenants.id = tenant_product_entitlements.tenant_id
       where tenant_product_entitlements.tenant_id = $1
         and tenant_product_entitlements.product_key = $2
         and tenant_product_entitlements.status in ('active', 'trial')
         and tenants.status = 'active'
     ) as allowed`,
    [input.tenantId, input.productKey],
  );
  return row?.allowed === true;
}

export async function assertProductAccess(
  client: PoolClient,
  input: { tenantId: string; productKey: ProductKey },
): Promise<void> {
  if (!await hasProductAccess(client, input)) {
    throw new Error(`${input.productKey[0].toUpperCase()}${input.productKey.slice(1)} is not included for this organisation.`);
  }
}

export function entitlementStatus(
  entitlements: ProductEntitlement[],
  productKey: ProductKey,
): ProductEntitlementStatus {
  return entitlements.find((item) => item.productKey === productKey)?.status ?? "locked";
}
