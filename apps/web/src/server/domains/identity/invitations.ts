import { randomBytes, createHash } from "crypto";
import type { PoolClient } from "@neondatabase/serverless";
import type { AppRole } from "@hized/contracts";

const RAW_TOKEN_BYTES = 32;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Creates a pending invitation and returns the raw token as a link to
 * show/copy in the admin UI (Resend is skipped for Phase 0 — no email is
 * sent). The raw token only ever exists here and in that link; only its
 * hash is stored.
 *
 * Must run inside withUserContext(callerProfileId, ...) — RLS's
 * "invitations: company_admin write" policy is what actually enforces
 * that only a company_admin (or platform admin) of `tenantId` can call
 * this; there's no separate application-level role check here by design.
 */
export async function createInvitation(
  client: PoolClient,
  opts: { tenantId: string; email: string; role: AppRole; orgNodeId?: string; invitedBy: string },
): Promise<{ invitationId: string; rawToken: string; inviteUrl: string }> {
  const rawToken = randomBytes(RAW_TOKEN_BYTES).toString("base64url");
  const { rows: [row] } = await client.query(
    `insert into public.invitations (tenant_id, email, role, org_node_id, invited_by, token_hash)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [opts.tenantId, opts.email, opts.role, opts.orgNodeId ?? null, opts.invitedBy, hashToken(rawToken)],
  );
  return {
    invitationId: row.id,
    rawToken,
    inviteUrl: `/invite/${rawToken}`,
  };
}

export interface InvitationPreview {
  invitationId: string;
  tenantId: string;
  tenantName: string;
  email: string;
  role: AppRole;
  expiresAt: string;
}

/**
 * Read-only preview for the public /invite/[token] page — runs before
 * the visitor is authenticated, so it goes through the SECURITY DEFINER
 * public.find_invitation_preview() function (see 0004_invite_provisioning.sql)
 * rather than a normal RLS-gated table read, which would see nothing at
 * this point (no session context yet).
 */
export async function findInvitationPreview(
  client: PoolClient,
  rawToken: string,
): Promise<InvitationPreview | null> {
  const { rows } = await client.query("select * from public.find_invitation_preview($1)", [hashToken(rawToken)]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    invitationId: row.invitation_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  };
}
