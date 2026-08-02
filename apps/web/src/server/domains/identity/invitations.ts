import { randomBytes, createHash } from "crypto";
import type { PoolClient } from "@neondatabase/serverless";
import type { AppRole } from "@hized/contracts";

const RAW_TOKEN_BYTES = 32;
const RAW_TOKEN_LENGTH = 43;

export function isValidInviteToken(rawToken: string): boolean {
  return rawToken.length === RAW_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(rawToken);
}

export function hashToken(rawToken: string): string {
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
  if (opts.orgNodeId) {
    const { rowCount } = await client.query(
      "select 1 from public.org_nodes where id = $1 and tenant_id = $2",
      [opts.orgNodeId, opts.tenantId],
    );
    if (rowCount === 0) throw new Error("Invitation scope does not belong to this tenant.");
  }
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
  if (!isValidInviteToken(rawToken)) return null;
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

/**
 * Atomically consumes a token for a Better Auth user. The database resolves
 * the user's verified identity record and requires its email to match the
 * invitation, so callers never choose which email/tenant the token grants.
 */
export async function acceptInvitationByToken(
  client: PoolClient,
  opts: { authUserId: string; rawToken: string },
): Promise<{ profileId: string; tenantId: string; tenantSlug: string }> {
  if (!isValidInviteToken(opts.rawToken)) throw new Error("Invitation token is malformed.");
  const { rows: [row] } = await client.query(
    "select * from public.accept_invitation_by_token($1, $2)",
    [opts.authUserId, hashToken(opts.rawToken)],
  );
  return {
    profileId: row.profile_id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
  };
}
