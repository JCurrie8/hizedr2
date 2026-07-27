import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { auth } from "../identity/auth";
import { getAuthContext } from "./auth-context";

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
      "insert into public.invitations (tenant_id, email, role, token_hash) values ($1, $2, 'manager', 'unused')",
      [tenantAId, email],
    );

    // asResponse: true gives back a real Response with a correctly signed
    // Set-Cookie header — reconstructing the cookie by hand from the raw
    // token doesn't work, Better Auth signs session cookies by default.
    const response = await auth.api.signUpEmail({
      body: { email, name: "Ctx Test", password: "correct-horse-battery-staple" },
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
});
