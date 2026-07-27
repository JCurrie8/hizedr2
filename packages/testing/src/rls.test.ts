import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withUserContext } from "@hized/db";
import { getAdminPool, createTenantWithUser, cleanupFixture, type TenantFixture } from "./fixtures";

/**
 * Proves Postgres RLS actually enforces tenant isolation for the app's
 * restricted app_user connection (see db/setup-app-role.mjs) — not just
 * that policies exist syntactically. Requires MIGRATIONS_DATABASE_URL and
 * DATABASE_URL to point at a real (dev/CI) Neon branch.
 */
describe("RLS tenant isolation", () => {
  const admin = getAdminPool();
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await createTenantWithUser(admin, {
      slug: `rls-test-a-${Date.now()}`,
      name: "RLS Test A",
      email: `rls-a-${Date.now()}@test.local`,
    });
    tenantB = await createTenantWithUser(admin, {
      slug: `rls-test-b-${Date.now()}`,
      name: "RLS Test B",
      email: `rls-b-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, tenantA);
    await cleanupFixture(admin, tenantB);
    await admin.end();
  });

  it("a tenant member sees exactly their own tenant", async () => {
    // tenants' SELECT policy isn't gated by current_tenant_id() — a user
    // can always list every tenant they belong to, not just "the current
    // one" (needed for a tenant picker), so no tenantId is passed here.
    const rows = await withUserContext({ userId: tenantA.profileId }, (c) =>
      c.query("select id from public.tenants").then((r) => r.rows),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(tenantA.tenantId);
  });

  it("cannot SELECT another tenant's row by id", async () => {
    const rows = await withUserContext({ userId: tenantA.profileId }, (c) =>
      c.query("select id from public.tenants where id = $1", [tenantB.tenantId]).then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  it("UPDATE against another tenant's row affects zero rows, not an error", async () => {
    const rowCount = await withUserContext({ userId: tenantA.profileId }, (c) =>
      c
        .query("update public.tenants set name = 'hacked' where id = $1", [tenantB.tenantId])
        .then((r) => r.rowCount),
    );
    expect(rowCount).toBe(0);

    const { rows } = await admin.query("select name from public.tenants where id = $1", [tenantB.tenantId]);
    expect(rows[0].name).toBe("RLS Test B");
  });

  it("fails closed: no session variable set means zero rows, not all rows", async () => {
    const rows = await withUserContext({ userId: null }, (c) =>
      c.query("select id from public.tenants").then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  it("cross-tenant membership listing is isolated when tenant context is set", async () => {
    const rows = await withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (c) =>
      c.query("select tenant_id from public.tenant_memberships").then((r) => r.rows),
    );
    expect(rows.every((r) => r.tenant_id === tenantA.tenantId)).toBe(true);
  });

  it("a tenant-scoped table is invisible with userId set but no tenantId (fails closed, not open)", async () => {
    const rows = await withUserContext({ userId: tenantA.profileId }, (c) =>
      c.query("select tenant_id from public.tenant_memberships").then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  it("a user with memberships in BOTH tenants only sees the explicitly-scoped one's org data, never both mixed", async () => {
    // The regression this guards against: current_tenant_id() used to be
    // derived via `limit 1` over the user's active memberships, which is
    // wrong for anyone (e.g. Hized consultancy staff) belonging to more
    // than one tenant — and current_user_scope_paths() could then mix org
    // hierarchy paths across tenants. Give tenantA's user a second,
    // active membership in tenantB and prove scope stays pinned to
    // whichever tenant is explicitly passed to withUserContext.
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, status) values ($1, $2, 'company_admin', 'active')",
      [tenantB.tenantId, tenantA.profileId],
    );
    try {
      const rowsScopedToA = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        (c) => c.query("select tenant_id from public.tenant_memberships").then((r) => r.rows),
      );
      expect(rowsScopedToA.every((r) => r.tenant_id === tenantA.tenantId)).toBe(true);

      const rowsScopedToB = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        (c) => c.query("select tenant_id from public.tenant_memberships").then((r) => r.rows),
      );
      expect(rowsScopedToB.every((r) => r.tenant_id === tenantB.tenantId)).toBe(true);
    } finally {
      await admin.query("delete from public.tenant_memberships where tenant_id = $1 and user_id = $2", [
        tenantB.tenantId,
        tenantA.profileId,
      ]);
    }
  });
});
