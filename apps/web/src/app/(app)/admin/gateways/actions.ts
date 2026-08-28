"use server";

import { withUserContext } from "@hized/db";
import { revalidatePath } from "next/cache";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import {
  createSqlGatewayEnrollment,
  revokeSqlGateway,
} from "@/server/domains/connectors/sql-gateways";
import { assertProductAccess } from "@/server/domains/products/entitlements";

export interface GatewayEnrollmentState {
  enrollmentToken: string | null;
  expiresAt: string | null;
  error: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredName(formData: FormData, key: string, label: string): string {
  const value = String(formData.get(key) ?? "").trim();
  if (value.length < 2 || value.length > 120) throw new Error(`${label} must be between 2 and 120 characters.`);
  return value;
}

async function requireGatewayAdmin() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin") throw new Error("Only a Company Admin can manage private gateways.");
  return ctx;
}

export async function createGatewayEnrollmentAction(
  _previous: GatewayEnrollmentState,
  formData: FormData,
): Promise<GatewayEnrollmentState> {
  try {
    const ctx = await requireGatewayAdmin();
    const gatewayName = requiredName(formData, "gatewayName", "Gateway name");
    const connectorName = requiredName(formData, "connectorName", "Connection name");
    const enrollment = await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        await assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" });
        const created = await createSqlGatewayEnrollment(client, {
          tenantId: ctx.tenant.id,
          name: gatewayName,
          connectorName,
          actorUserId: ctx.profileId,
        });
        await insertAuditLog(client, {
          tenantId: ctx.tenant.id,
          actorUserId: ctx.profileId,
          action: "connect.gateway_enrollment_created",
          targetType: "connector_gateway",
          targetId: created.gatewayId,
          metadata: { gatewayName, connectorName, expiresAt: created.expiresAt },
        });
        return created;
      },
    );
    revalidatePath("/admin/gateways");
    return { enrollmentToken: enrollment.token, expiresAt: enrollment.expiresAt, error: null };
  } catch (error) {
    return {
      enrollmentToken: null,
      expiresAt: null,
      error: error instanceof Error ? error.message : "Could not create gateway enrolment.",
    };
  }
}

export async function revokeGatewayAction(formData: FormData): Promise<void> {
  const ctx = await requireGatewayAdmin();
  const gatewayId = String(formData.get("gatewayId") ?? "");
  if (!UUID_PATTERN.test(gatewayId)) throw new Error("Choose a valid gateway.");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await revokeSqlGateway(client, { tenantId: ctx.tenant.id, gatewayId, actorUserId: ctx.profileId });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.gateway_revoked",
      targetType: "connector_gateway",
      targetId: gatewayId,
      metadata: {},
    });
  });
  revalidatePath("/admin/gateways");
  revalidatePath("/admin/connect");
  revalidatePath("/admin/queries");
}
