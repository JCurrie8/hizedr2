import type { AppRole } from "@hized/contracts";

/**
 * Which roles must hold a second factor before they can use the product.
 *
 * Blueprint 9.3 requires "MFA and SSO for privileged users", and the Phase 0
 * plan recorded an explicit decision to enforce this in Phase 0 rather than
 * defer it. Privileged here means the two roles that can change other
 * people's access: a Company Admin (invites members, sets roles and scopes,
 * governs KPI definitions for their tenant) and a Platform Admin (reaches
 * across every tenant). Ordinary members are not forced through TOTP setup —
 * that would block the pilot's day-one users for no proportionate gain, and
 * the blueprint asks for it on privileged users specifically.
 */
const MFA_REQUIRED_TENANT_ROLES: readonly AppRole[] = ["company_admin"];

/** Paths a privileged user without MFA may still reach, or enforcement traps them. */
const TENANT_MFA_EXEMPT_PREFIXES = ["/admin/security"] as const;
const PLATFORM_ADMIN_MFA_EXEMPT_PREFIXES = ["/platform-admin/security"] as const;

export function tenantRoleRequiresMfa(role: AppRole): boolean {
  return MFA_REQUIRED_TENANT_ROLES.includes(role);
}

function isExempt(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Returns the path to send the user to in order to enrol, or null if the
 * request may proceed. Deliberately allows the enrolment page itself
 * through — otherwise enforcement is a redirect loop and the user can
 * never satisfy it.
 *
 * Sign-out must also stay reachable: it is a POST to /api/auth/*, which
 * layouts never gate, so a half-enrolled user is never locked in.
 */
export function mfaEnrolmentRedirect(opts: {
  scope: "tenant" | "platform_admin";
  role?: AppRole;
  twoFactorEnabled: boolean;
  pathname: string;
}): string | null {
  if (opts.twoFactorEnabled) return null;

  if (opts.scope === "platform_admin") {
    if (isExempt(opts.pathname, PLATFORM_ADMIN_MFA_EXEMPT_PREFIXES)) return null;
    return "/platform-admin/security";
  }

  if (!opts.role || !tenantRoleRequiresMfa(opts.role)) return null;
  if (isExempt(opts.pathname, TENANT_MFA_EXEMPT_PREFIXES)) return null;
  return "/admin/security";
}
