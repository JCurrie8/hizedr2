"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import type { AppRole } from "@hized/contracts";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import {
  isAppRole,
  isManageableMembershipStatus,
  updateMembershipAccess,
} from "@/server/domains/access-control/membership-access";
import { createInvitation } from "@/server/domains/identity/invitations";

export interface InviteFormState {
  inviteUrl: string | null;
  error: string | null;
}

export interface MemberAccessFormState {
  saved: boolean;
  error: string | null;
}

/**
 * Returns state (via useActionState) rather than just revalidating, since
 * the raw invite token only ever exists at this one instant — only its
 * hash is persisted (see invitations.ts) — so it has to come back to the
 * client here or it's gone. Resend is skipped for Phase 0, so this link
 * is the only way the invite reaches anyone; the admin copies and sends
 * it themselves.
 */
export async function createInviteAction(
  _prevState: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return { inviteUrl: null, error: "Not signed in to a tenant." };
  if (ctx.role !== "company_admin") {
    return { inviteUrl: null, error: "Only a company admin can invite users." };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const roleValue = String(formData.get("role") ?? "");
  const orgNodeId = String(formData.get("orgNodeId") ?? "") || undefined;
  if (!email) return { inviteUrl: null, error: "Email is required." };
  if (!isAppRole(roleValue)) return { inviteUrl: null, error: "Choose a valid role." };
  const role: AppRole = roleValue;
  if (role !== "company_admin" && !orgNodeId) {
    return { inviteUrl: null, error: "Choose an organisation scope for this user." };
  }

  try {
    const invitation = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (c) => {
      const created = await createInvitation(c, {
        tenantId: ctx.tenant.id,
        email,
        role,
        orgNodeId,
        invitedBy: ctx.profileId,
      });
      await insertAuditLog(c, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "invitation.created",
        targetType: "invitation",
        targetId: created.invitationId,
        metadata: { email, role, orgNodeId: orgNodeId ?? null },
      });
      return created;
    });

    revalidatePath("/admin/users");
    return { inviteUrl: invitation.inviteUrl, error: null };
  } catch (err) {
    return { inviteUrl: null, error: err instanceof Error ? err.message : "Could not create invitation." };
  }
}

export async function updateMemberAccessAction(
  _prevState: MemberAccessFormState,
  formData: FormData,
): Promise<MemberAccessFormState> {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return { saved: false, error: "Not signed in to a tenant." };
  if (ctx.role !== "company_admin") {
    return { saved: false, error: "Only a Company Admin can change member access." };
  }

  const membershipId = String(formData.get("membershipId") ?? "");
  const roleValue = String(formData.get("role") ?? "");
  const statusValue = String(formData.get("status") ?? "");
  const orgNodeId = String(formData.get("orgNodeId") ?? "") || undefined;
  if (!membershipId) return { saved: false, error: "Member is required." };
  if (!isAppRole(roleValue)) return { saved: false, error: "Choose a valid role." };
  if (!isManageableMembershipStatus(statusValue)) {
    return { saved: false, error: "Choose a valid membership status." };
  }

  try {
    await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
      const updated = await updateMembershipAccess(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        membershipId,
        role: roleValue,
        status: statusValue,
        orgNodeId,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "membership.access_updated",
        targetType: "tenant_membership",
        targetId: membershipId,
        metadata: {
          role: updated.role,
          status: updated.status,
          orgNodeId: updated.primaryScope?.orgNodeId ?? null,
        },
      });
    });
    revalidatePath("/admin/users");
    return { saved: true, error: null };
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : "Could not update member access." };
  }
}
