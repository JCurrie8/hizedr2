"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import type { OrgNodeType } from "@hized/contracts";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { writeAuditLog } from "@/server/domains/access-control/audit";
import { createOrgNode, deactivateOrgNode } from "@/server/domains/organisation/org-nodes";

/**
 * Both actions re-derive the caller's context fresh from the verified
 * session rather than trusting anything in the submitted form — the
 * tenantId used for withUserContext (and therefore what RLS enforces)
 * always comes from getAuthContextFromRequest(), never from client input.
 * The "company_admin write" RLS policy is still the actual enforcement;
 * this check just gives a clean error instead of a silent 0-row no-op.
 */
async function requireCompanyAdmin() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin") throw new Error("Only a company admin can manage the organisation structure.");
  return ctx;
}

export async function createNodeAction(formData: FormData) {
  const ctx = await requireCompanyAdmin();

  const nodeType = String(formData.get("nodeType")) as OrgNodeType;
  const name = String(formData.get("name") ?? "").trim();
  const parentId = String(formData.get("parentId") ?? "") || null;
  if (!name) throw new Error("Name is required.");

  const node = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (c) =>
    createOrgNode(c, { tenantId: ctx.tenant.id, nodeType, name, parentId }),
  );

  await writeAuditLog({
    tenantId: ctx.tenant.id,
    actorUserId: ctx.profileId,
    action: "org_node.created",
    targetType: "org_node",
    targetId: node.orgNodeId,
    metadata: { nodeType, name, parentId },
  });

  revalidatePath("/admin/organisation");
}

export async function deactivateNodeAction(formData: FormData) {
  const ctx = await requireCompanyAdmin();
  const orgNodeId = String(formData.get("orgNodeId"));

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (c) =>
    deactivateOrgNode(c, { orgNodeId }),
  );

  await writeAuditLog({
    tenantId: ctx.tenant.id,
    actorUserId: ctx.profileId,
    action: "org_node.deactivated",
    targetType: "org_node",
    targetId: orgNodeId,
  });

  revalidatePath("/admin/organisation");
}
