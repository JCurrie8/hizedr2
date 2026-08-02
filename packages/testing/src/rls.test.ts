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

  it("rejects a tenant context without an authenticated user", async () => {
    await expect(
      withUserContext({ userId: null, tenantId: tenantA.tenantId }, (c) =>
        c.query("select id from public.org_nodes"),
      ),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("prevents self-service updates to profile identity and staff columns", async () => {
    await expect(
      withUserContext({ userId: tenantA.profileId }, (c) =>
        c.query("update public.profiles set is_hized_staff = true where id = $1", [tenantA.profileId]),
      ),
    ).rejects.toThrow(/permission denied/);

    const rowCount = await withUserContext({ userId: tenantA.profileId }, (c) =>
      c.query("update public.profiles set full_name = 'RLS Display Name' where id = $1", [tenantA.profileId])
        .then((result) => result.rowCount),
    );
    expect(rowCount).toBe(1);
  });

  it("rejects an audit event whose actor does not match the session", async () => {
    await expect(
      withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (c) =>
        c.query(
          "insert into public.audit_log (tenant_id, actor_user_id, action) values ($1, $2, 'forged.event')",
          [tenantA.tenantId, tenantB.profileId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rolls back a privileged mutation when its in-transaction audit insert fails", async () => {
    const marker = `atomic-audit-${Date.now()}`;
    await expect(
      withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, async (c) => {
        await c.query(
          "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'team', $2)",
          [tenantA.tenantId, marker],
        );
        await c.query(
          "insert into public.audit_log (tenant_id, actor_user_id, action) values ($1, $2, 'forged.event')",
          [tenantA.tenantId, tenantB.profileId],
        );
      }),
    ).rejects.toThrow(/row-level security/);

    const { rows } = await admin.query("select 1 from public.org_nodes where code = $1", [marker]);
    expect(rows).toHaveLength(0);
  });

  it("does not expose Hized SECURITY DEFINER helpers to PostgreSQL PUBLIC", async () => {
    const { rows } = await admin.query(
      `select p.proname,
              coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as public_execute
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
       where n.nspname = 'public'
         and p.proname = any($1::text[])
       group by p.proname
       order by p.proname`,
      [[
        "accept_invitation_by_token",
        "current_user_has_tenant_access",
        "current_user_tenant_ids",
        "get_membership_for_slug",
        "get_profile_for_auth_user",
        "has_pending_invitation_by_token",
      ]],
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.public_execute === false)).toBe(true);
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

  it("a mismatched user and tenant context still fails closed at the RLS boundary", async () => {
    const marker = `mismatched-context-${Date.now()}`;
    const { rows: [node] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'team', $2) returning id",
      [tenantB.tenantId, marker],
    );
    const { rows: [invitation] } = await admin.query(
      `insert into public.invitations (tenant_id, email, role, token_hash)
       values ($1, $2, 'employee', encode(digest($2, 'sha256'), 'hex')) returning id`,
      [tenantB.tenantId, `${marker}@test.local`],
    );
    try {
      const rows = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        async (c) => {
          const memberships = await c.query(
            "select id from public.tenant_memberships where tenant_id = $1",
            [tenantB.tenantId],
          );
          const nodes = await c.query("select id from public.org_nodes where tenant_id = $1", [tenantB.tenantId]);
          const invitations = await c.query(
            "select id from public.invitations where tenant_id = $1",
            [tenantB.tenantId],
          );
          return [...memberships.rows, ...nodes.rows, ...invitations.rows];
        },
      );
      expect(rows).toHaveLength(0);
    } finally {
      await admin.query("delete from public.invitations where id = $1", [invitation.id]);
      await admin.query("delete from public.org_nodes where id = $1", [node.id]);
    }
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

  it("a company_admin of multiple tenants only sees the current tenant's audit log, never both mixed", async () => {
    // Same regression class as the test above, but for audit_log
    // specifically (0011) — the single most sensitive table in the
    // schema, so worth its own explicit case rather than assuming the
    // fix generalizes.
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, status) values ($1, $2, 'company_admin', 'active')",
      [tenantB.tenantId, tenantA.profileId],
    );
    const { rows: [logA] } = await admin.query(
      "insert into public.audit_log (tenant_id, actor_user_id, action) values ($1, $2, 'test.event') returning id",
      [tenantA.tenantId, tenantA.profileId],
    );
    const { rows: [logB] } = await admin.query(
      "insert into public.audit_log (tenant_id, actor_user_id, action) values ($1, $2, 'test.event') returning id",
      [tenantB.tenantId, tenantA.profileId],
    );
    try {
      const rowsScopedToA = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        (c) => c.query("select tenant_id from public.audit_log where action = 'test.event'").then((r) => r.rows),
      );
      expect(rowsScopedToA.every((r) => r.tenant_id === tenantA.tenantId)).toBe(true);

      const rowsScopedToB = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        (c) => c.query("select tenant_id from public.audit_log where action = 'test.event'").then((r) => r.rows),
      );
      expect(rowsScopedToB.every((r) => r.tenant_id === tenantB.tenantId)).toBe(true);
    } finally {
      await admin.query("delete from public.audit_log where id in ($1, $2)", [logA.id, logB.id]);
      await admin.query("delete from public.tenant_memberships where tenant_id = $1 and user_id = $2", [
        tenantB.tenantId,
        tenantA.profileId,
      ]);
    }
  });
});
