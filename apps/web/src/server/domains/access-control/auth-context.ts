import type { AppRole } from "@hized/contracts";
import { dbPool as pool } from "../../db-pool";
import { auth } from "../identity/auth";
import { writeAuditLog } from "./audit";
import { mfaEnrolmentPath, tenantRoleRequiresMfa, type MfaScope } from "./mfa-policy";

export interface TenantAuthContext {
  kind: "tenant";
  profileId: string;
  fullName: string | null;
  isHizedStaff: boolean;
  isPlatformAdmin: boolean;
  /** Better Auth's own flag — the source of truth for whether TOTP is set up. */
  twoFactorEnabled: boolean;
  tenant: {
    id: string;
    slug: string;
    name: string;
    branding: Record<string, unknown>;
    timezone: string;
  };
  role: AppRole;
}

export interface PlatformAdminAuthContext {
  kind: "platform_admin";
  profileId: string;
  fullName: string | null;
  twoFactorEnabled: boolean;
}

export interface MfaRequiredAuthContext {
  kind: "mfa_required";
  scope: MfaScope;
  enrolmentPath: string;
}

export type AuthResult =
  | TenantAuthContext
  | PlatformAdminAuthContext
  | MfaRequiredAuthContext
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

/**
 * The authorization gate every authenticated route goes through — see
 * db/migrations/0008_auth_context_lookups.sql for the trust model this
 * relies on (identity resolution is a trusted server-side step; RLS is
 * the enforcement boundary for everything after it).
 *
 * The hostname-resolved slug is NEVER trusted alone (per the Phase 0
 * plan): a mismatch between the requested tenant and the caller's actual
 * active membership is a "forbidden" result, audited as a denied
 * cross-tenant attempt, not a generic 404 that would leak whether the
 * slug exists.
 *
 * `requestHeaders` is passed in explicitly (dependency injection) rather
 * than calling next/headers() internally, so this is unit-testable
 * outside a real Next.js request — see auth-context.test.ts and
 * getAuthContextFromRequest() below for the actual route/layout call site.
 */
export async function getAuthContext(opts: {
  tenantSlug: string | null;
  platformAdminRoute?: boolean;
  /** Only the dedicated enrolment page may opt out of the MFA authority gate. */
  allowUnenrolledMfa?: boolean;
  requestHeaders: Headers;
}): Promise<AuthResult> {
  const session = await auth.api.getSession({ headers: opts.requestHeaders });
  if (!session) return { kind: "unauthenticated" };

  const { rows: profileRows } = await pool.query(
    "select * from public.get_profile_for_auth_user($1)",
    [session.user.id],
  );
  const profile = profileRows[0];
  if (!profile) return { kind: "unauthenticated" }; // provisioning didn't run — treat as not signed in

  const twoFactorEnabled = Boolean(
    (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled,
  );

  if (opts.platformAdminRoute) {
    if (!profile.is_platform_admin) return { kind: "forbidden" };
    if (!twoFactorEnabled && !opts.allowUnenrolledMfa) {
      return {
        kind: "mfa_required",
        scope: "platform_admin",
        enrolmentPath: mfaEnrolmentPath("platform_admin"),
      };
    }
    return {
      kind: "platform_admin",
      profileId: profile.profile_id,
      fullName: profile.full_name,
      twoFactorEnabled,
    };
  }

  if (!opts.tenantSlug) return { kind: "forbidden" };

  const { rows: membershipRows } = await pool.query(
    "select * from public.get_membership_for_slug($1, $2)",
    [profile.profile_id, opts.tenantSlug],
  );
  const membership = membershipRows[0];

  if (!membership) {
    // Resolve the tenant's id purely so the audit write itself can
    // satisfy "tenant_id = current_tenant_id()" — this is a narrow,
    // single-purpose transaction (writeAuditLog only ever runs the one
    // INSERT it controls), so it grants no actual access to that
    // tenant's data despite the caller having no membership there.
    const { rows: [tenant] } = await pool.query("select public.get_tenant_id_by_slug($1) as id", [opts.tenantSlug]);
    if (tenant?.id) {
      // Only log against a real tenant — a genuinely unknown slug has no
      // tenant_id to attribute the row to, and the audit_log insert
      // policy requires is_platform_admin() for tenant_id null (this
      // actor may not be one), so there's nothing safe/meaningful to
      // write in that case. It's a 404, not a security event.
      await writeAuditLog({
        tenantId: tenant.id,
        actorUserId: profile.profile_id,
        action: "access.cross_tenant_denied",
        metadata: { attemptedSlug: opts.tenantSlug },
      });
    }
    return { kind: "forbidden" };
  }

  if (
    tenantRoleRequiresMfa(membership.role) &&
    !twoFactorEnabled &&
    !opts.allowUnenrolledMfa
  ) {
    return {
      kind: "mfa_required",
      scope: "tenant",
      enrolmentPath: mfaEnrolmentPath("tenant"),
    };
  }

  return {
    kind: "tenant",
    profileId: profile.profile_id,
    fullName: profile.full_name,
    isHizedStaff: profile.is_hized_staff,
    isPlatformAdmin: profile.is_platform_admin,
    twoFactorEnabled,
    tenant: {
      id: membership.tenant_id,
      slug: opts.tenantSlug,
      name: membership.tenant_name,
      branding: membership.branding ?? {},
      timezone: membership.timezone,
    },
    role: membership.role,
  };
}

/**
 * Actual call site for layouts/pages: reads the tenant slug set by
 * middleware.ts (x-tenant-slug header) and the real request headers via
 * next/headers, then delegates to getAuthContext(). Keep this as the
 * only place next/headers() is imported for this purpose, so the rest
 * stays testable.
 */
export async function getAuthContextFromRequest(opts: {
  platformAdminRoute?: boolean;
  allowUnenrolledMfa?: boolean;
} = {}): Promise<AuthResult> {
  const { headers } = await import("next/headers");
  const h = await headers();
  return getAuthContext({
    tenantSlug: h.get("x-tenant-slug"),
    platformAdminRoute: opts.platformAdminRoute,
    allowUnenrolledMfa: opts.allowUnenrolledMfa,
    requestHeaders: h,
  });
}
