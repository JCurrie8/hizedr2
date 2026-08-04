"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { createInvitation } from "@/server/domains/identity/invitations";
import {
  isEntitlementStatus,
  isManageableTenantStatus,
  isProductKey,
  updateProductEntitlement,
  updateTenantConfiguration,
  updateTenantStatus,
} from "@/server/domains/platform-administration/tenants";

export interface PlatformAdminInviteState {
  inviteUrl: string | null;
  error: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requirePlatformAdmin() {
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });
  if (ctx.kind !== "platform_admin") throw new Error("Platform admin access only.");
  return ctx;
}

function requireTenantId(formData: FormData): string {
  const tenantId = String(formData.get("tenantId") ?? "");
  if (!UUID_PATTERN.test(tenantId)) throw new Error("Choose a valid tenant.");
  return tenantId;
}

function revalidateTenant(tenantId: string) {
  revalidatePath("/platform-admin");
  revalidatePath(`/platform-admin/tenants/${tenantId}`);
}

/** PLATFORM-001: create a tenant without developer database access. */
export async function createTenantAction(formData: FormData) {
  const ctx = await requirePlatformAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  if (!name || !slug) throw new Error("Name and slug are required.");
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Slug can only contain lowercase letters, numbers and hyphens.");
  }

  const tenantId = await withUserContext({ userId: ctx.profileId }, async (c) => {
    const { rows: [tenant] } = await c.query(
      "insert into public.tenants (slug, name) values ($1, $2) returning id",
      [slug, name],
    );
    await insertAuditLog(c, {
      tenantId: tenant.id,
      actorUserId: ctx.profileId,
      action: "tenant.created",
      targetType: "tenant",
      targetId: tenant.id,
      metadata: { name, slug },
    });
    return tenant.id as string;
  });
  redirect(`/platform-admin/tenants/${tenantId}`);
}

export async function updateTenantConfigurationAction(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const tenantId = requireTenantId(formData);
  const name = String(formData.get("name") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();
  const financialCalendarStartMonth = Number(formData.get("financialCalendarStartMonth"));
  const retentionValue = String(formData.get("dataRetentionDays") ?? "").trim();
  const dataRetentionDays = retentionValue ? Number(retentionValue) : null;

  await withUserContext({ userId: ctx.profileId, tenantId }, async (client) => {
    const { rows: [previous] } = await client.query(
      `select name, timezone, financial_calendar_start_month, data_retention_days
       from public.tenants where id = $1`,
      [tenantId],
    );
    if (!previous) throw new Error("Tenant not found.");
    const updated = await updateTenantConfiguration(client, {
      tenantId,
      name,
      timezone,
      financialCalendarStartMonth,
      dataRetentionDays,
    });
    await insertAuditLog(client, {
      tenantId,
      actorUserId: ctx.profileId,
      action: "tenant.configuration_updated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: { previous, updated },
    });
  });
  revalidateTenant(tenantId);
}

export async function updateProductEntitlementAction(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const tenantId = requireTenantId(formData);
  const productKey = String(formData.get("productKey") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!isProductKey(productKey)) throw new Error("Choose a valid product.");
  if (!isEntitlementStatus(status)) throw new Error("Choose a valid entitlement status.");

  await withUserContext({ userId: ctx.profileId, tenantId }, async (client) => {
    const changed = await updateProductEntitlement(client, {
      tenantId,
      productKey,
      status,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId,
      actorUserId: ctx.profileId,
      action: "tenant.product_entitlement_updated",
      targetType: "tenant_product_entitlement",
      targetId: `${tenantId}:${productKey}`,
      metadata: { productKey, ...changed },
    });
  });
  revalidateTenant(tenantId);
}

export async function updateTenantStatusAction(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const tenantId = requireTenantId(formData);
  const status = String(formData.get("status") ?? "");
  if (!isManageableTenantStatus(status)) throw new Error("Choose active or suspended.");

  await withUserContext({ userId: ctx.profileId, tenantId }, async (client) => {
    const changed = await updateTenantStatus(client, { tenantId, status });
    await insertAuditLog(client, {
      tenantId,
      actorUserId: ctx.profileId,
      action: status === "suspended" ? "tenant.suspended" : "tenant.reactivated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: changed,
    });
  });
  revalidateTenant(tenantId);
}

export async function createPlatformAdminInviteAction(
  _previousState: PlatformAdminInviteState,
  formData: FormData,
): Promise<PlatformAdminInviteState> {
  const ctx = await requirePlatformAdmin();
  const tenantId = requireTenantId(formData);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { inviteUrl: null, error: "Enter a valid email address." };

  try {
    const invitation = await withUserContext({ userId: ctx.profileId, tenantId }, async (client) => {
      const { rows: [tenant] } = await client.query("select status from public.tenants where id = $1", [tenantId]);
      if (!tenant) throw new Error("Tenant not found.");
      if (tenant.status !== "active") throw new Error("Reactivate the tenant before inviting a Company Admin.");
      const { rowCount: existingAdminCount } = await client.query(
        `select 1
         from public.tenant_memberships m
         join public.profiles p on p.id = m.user_id
         join public."user" u on u.id = p.auth_user_id
         where m.tenant_id = $1 and m.role = 'company_admin' and m.status = 'active'
           and lower(u.email) = lower($2)`,
        [tenantId, email],
      );
      if (existingAdminCount) throw new Error("That user is already an active Company Admin.");
      await client.query(
        `update public.invitations set status = 'revoked'
         where tenant_id = $1 and email = $2 and role = 'company_admin' and status = 'pending'`,
        [tenantId, email],
      );
      const created = await createInvitation(client, {
        tenantId,
        email,
        role: "company_admin",
        invitedBy: ctx.profileId,
      });
      await insertAuditLog(client, {
        tenantId,
        actorUserId: ctx.profileId,
        action: "platform_admin.company_admin_invited",
        targetType: "invitation",
        targetId: created.invitationId,
        metadata: { email, role: "company_admin" },
      });
      return created;
    });
    revalidateTenant(tenantId);
    const baseUrl = (process.env.BETTER_AUTH_URL ?? "https://hized.app").replace(/\/$/, "");
    return { inviteUrl: `${baseUrl}${invitation.inviteUrl}`, error: null };
  } catch (error) {
    return { inviteUrl: null, error: error instanceof Error ? error.message : "Could not create invitation." };
  }
}
