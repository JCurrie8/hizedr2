import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { auth } from "../identity/auth";
import { getAuthContext } from "./auth-context";
import { mfaEnrolmentRedirect } from "./mfa-policy";
import { hashToken } from "../identity/invitations";

/**
 * Proves getAuthContext() end to end: unauthenticated, wrong-tenant
 * (denied + audited), and correct-tenant journeys, against real sessions
 * created through Better Auth's actual signup API — not mocked.
 */
describe("getAuthContext", () => {
  const admin = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  let tenantAId: string;
  let tenantBId: string;
  const tenantASlug = `ctx-test-a-${Date.now()}`;
  const tenantBSlug = `ctx-test-b-${Date.now()}`;
  const email = `ctx-test-${Date.now()}@test.local`;
  let sessionHeaders: Headers;
  let profileId: string;
  const rawInviteToken = "c".repeat(43);

  beforeAll(async () => {
    const { rows: [tenantA] } = await admin.query(
      "insert into public.tenants (slug, name) values ($1, 'Ctx Test A') returning id",
      [tenantASlug],
    );
    tenantAId = tenantA.id;
    const { rows: [tenantB] } = await admin.query(
      "insert into public.tenants (slug, name) values ($1, 'Ctx Test B') returning id",
      [tenantBSlug],
    );
    tenantBId = tenantB.id;

    await admin.query(
      "insert into public.invitations (tenant_id, email, role, token_hash) values ($1, $2, 'manager', $3)",
      [tenantAId, email, hashToken(rawInviteToken)],
    );

    // asResponse: true gives back a real Response with a correctly signed
    // Set-Cookie header — reconstructing the cookie by hand from the raw
    // token doesn't work, Better Auth signs session cookies by default.
    const response = await auth.api.signUpEmail({
      body: { email, name: "Ctx Test", password: "correct-horse-battery-staple" },
      headers: new Headers({ "x-invite-token": rawInviteToken }),
      asResponse: true,
    });
    const setCookie = response.headers.get("set-cookie") ?? "";
    const cookiePair = setCookie.split(";")[0];
    sessionHeaders = new Headers({ cookie: cookiePair });

    const { rows } = await admin.query(
      `select p.id from public.profiles p join "user" u on u.id = p.auth_user_id where u.email = $1`,
      [email],
    );
    profileId = rows[0].id;
  });

  afterAll(async () => {
    await admin.query("delete from public.audit_log where tenant_id in ($1,$2)", [tenantAId, tenantBId]);
    await admin.query("delete from public.tenant_memberships where tenant_id in ($1,$2)", [tenantAId, tenantBId]);
    await admin.query("delete from public.invitations where tenant_id in ($1,$2)", [tenantAId, tenantBId]);
    await admin.query(`delete from public.profiles where id = $1`, [profileId]);
    await admin.query(`delete from "user" where email = $1`, [email]);
    await admin.query("delete from public.tenants where id in ($1,$2)", [tenantAId, tenantBId]);
    await admin.end();
  });

  it("returns unauthenticated with no session", async () => {
    const result = await getAuthContext({ tenantSlug: tenantASlug, requestHeaders: new Headers() });
    expect(result.kind).toBe("unauthenticated");
  });

  it("returns tenant context for a tenant the user actually belongs to", async () => {
    const result = await getAuthContext({ tenantSlug: tenantASlug, requestHeaders: sessionHeaders });
    expect(result.kind).toBe("tenant");
    if (result.kind === "tenant") {
      expect(result.tenant.slug).toBe(tenantASlug);
      expect(result.role).toBe("manager");
      expect(result.profileId).toBe(profileId);
    }
  });

  it("denies and audits access to a tenant the user does not belong to", async () => {
    const result = await getAuthContext({ tenantSlug: tenantBSlug, requestHeaders: sessionHeaders });
    expect(result.kind).toBe("forbidden");

    const { rows } = await admin.query(
      "select action, metadata from public.audit_log where tenant_id = $1 and actor_user_id = $2",
      [tenantBId, profileId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("access.cross_tenant_denied");
    expect(rows[0].metadata.attemptedSlug).toBe(tenantBSlug);
  });

  it("denies non-platform-admins on a platform-admin route", async () => {
    const result = await getAuthContext({ tenantSlug: null, platformAdminRoute: true, requestHeaders: sessionHeaders });
    expect(result.kind).toBe("forbidden");
  });

  it("carries Better Auth's real twoFactorEnabled flag through to MFA enforcement", async () => {
    // The unit tests cover the policy in isolation; this covers the join
    // the policy depends on — that a real Better Auth session actually
    // surfaces twoFactorEnabled on the context. If this silently came back
    // undefined, every privileged user would be treated as unenrolled (or,
    // with the opposite bug, enforcement would never fire at all).
    const result = await getAuthContext({ tenantSlug: tenantASlug, requestHeaders: sessionHeaders });
    expect(result.kind).toBe("tenant");
    if (result.kind !== "tenant") return;

    expect(result.twoFactorEnabled).toBe(false); // freshly signed up, never enrolled

    // This fixture is a 'manager', so enforcement correctly leaves them alone…
    expect(
      mfaEnrolmentRedirect({
        scope: "tenant",
        role: result.role,
        twoFactorEnabled: result.twoFactorEnabled,
        pathname: "/home",
      }),
    ).toBeNull();

    // …but the same unenrolled account as a Company Admin must be stopped.
    expect(
      mfaEnrolmentRedirect({
        scope: "tenant",
        role: "company_admin",
        twoFactorEnabled: result.twoFactorEnabled,
        pathname: "/home",
      }),
    ).toBe("/admin/security");
  });

  it("withholds Company Admin authority until MFA is enrolled", async () => {
    await admin.query(
      "update public.tenant_memberships set role = 'company_admin' where tenant_id = $1 and user_id = $2",
      [tenantAId, profileId],
    );

    try {
      const denied = await getAuthContext({ tenantSlug: tenantASlug, requestHeaders: sessionHeaders });
      expect(denied).toEqual({
        kind: "mfa_required",
        scope: "tenant",
        enrolmentPath: "/admin/security",
      });

      const enrolmentContext = await getAuthContext({
        tenantSlug: tenantASlug,
        requestHeaders: sessionHeaders,
        allowUnenrolledMfa: true,
      });
      expect(enrolmentContext.kind).toBe("tenant");
      if (enrolmentContext.kind === "tenant") {
        expect(enrolmentContext.role).toBe("company_admin");
        expect(enrolmentContext.twoFactorEnabled).toBe(false);
      }
    } finally {
      await admin.query(
        "update public.tenant_memberships set role = 'manager' where tenant_id = $1 and user_id = $2",
        [tenantAId, profileId],
      );
    }
  });

  it("withholds Platform Admin authority until MFA is enrolled", async () => {
    await admin.query("insert into public.platform_admins (user_id) values ($1)", [profileId]);

    try {
      const denied = await getAuthContext({
        tenantSlug: null,
        platformAdminRoute: true,
        requestHeaders: sessionHeaders,
      });
      expect(denied).toEqual({
        kind: "mfa_required",
        scope: "platform_admin",
        enrolmentPath: "/platform-admin/security",
      });

      const enrolmentContext = await getAuthContext({
        tenantSlug: null,
        platformAdminRoute: true,
        requestHeaders: sessionHeaders,
        allowUnenrolledMfa: true,
      });
      expect(enrolmentContext.kind).toBe("platform_admin");
    } finally {
      await admin.query("delete from public.platform_admins where user_id = $1", [profileId]);
    }
  });
});
