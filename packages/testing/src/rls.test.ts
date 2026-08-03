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
  let tenantEmployee: TenantFixture;
  let connectorAId: string;
  let connectorBId: string;
  let connectorEmployeeId: string;
  let pipelineAId: string;
  let pipelineBId: string;
  let mappingAId: number;
  let mappingBId: number;

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
    tenantEmployee = await createTenantWithUser(admin, {
      slug: `rls-test-employee-${Date.now()}`,
      name: "RLS Test Employee",
      email: `rls-employee-${Date.now()}@test.local`,
      role: "employee",
    });

    await admin.query(
      `insert into public.tenant_branding (tenant_id, primary_color, accent_color, typography, published_by)
       values ($1, '#112233', '#335577', 'clean', $2),
              ($3, '#223344', '#446688', 'geometric', $4),
              ($5, '#334455', '#557799', 'hized', $6)`,
      [
        tenantA.tenantId, tenantA.profileId,
        tenantB.tenantId, tenantB.profileId,
        tenantEmployee.tenantId, tenantEmployee.profileId,
      ],
    );
    await admin.query(
      `insert into public.tenant_branding_drafts
         (tenant_id, primary_color, accent_color, typography, updated_by)
       values ($1, '#111111', '#555555', 'clean', $2),
              ($3, '#222222', '#666666', 'geometric', $4)`,
      [tenantA.tenantId, tenantA.profileId, tenantB.tenantId, tenantB.profileId],
    );

    const { rows: [connectorA] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, created_by)
       values ($1, 'salesforce', 'Salesforce A', $2) returning id`,
      [tenantA.tenantId, tenantA.profileId],
    );
    connectorAId = connectorA.id;
    const { rows: [connectorB] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, created_by)
       values ($1, 'salesforce', 'Salesforce B', $2) returning id`,
      [tenantB.tenantId, tenantB.profileId],
    );
    connectorBId = connectorB.id;
    const { rows: [connectorEmployee] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, created_by)
       values ($1, 'file_upload', 'Employee tenant file source', $2) returning id`,
      [tenantEmployee.tenantId, tenantEmployee.profileId],
    );
    connectorEmployeeId = connectorEmployee.id;
    const { rows: [pipelineA] } = await admin.query(
      `insert into public.pipelines
         (tenant_id, connector_id, name, load_mode, key_columns, created_by)
       values ($1, $2, 'Salesforce accounts', 'upsert', array['Id'], $3) returning id`,
      [tenantA.tenantId, connectorAId, tenantA.profileId],
    );
    pipelineAId = pipelineA.id;
    const { rows: [pipelineB] } = await admin.query(
      `insert into public.pipelines
         (tenant_id, connector_id, name, load_mode, key_columns, created_by)
       values ($1, $2, 'Salesforce contacts', 'upsert', array['Id'], $3) returning id`,
      [tenantB.tenantId, connectorBId, tenantB.profileId],
    );
    pipelineBId = pipelineB.id;
    const { rows: [mappingA] } = await admin.query(
      `insert into public.pipeline_field_mappings
         (tenant_id, pipeline_id, source_field, target_field, position)
       values ($1, $2, 'Id', 'account_id', 0) returning id`,
      [tenantA.tenantId, pipelineAId],
    );
    mappingAId = Number(mappingA.id);
    const { rows: [mappingB] } = await admin.query(
      `insert into public.pipeline_field_mappings
         (tenant_id, pipeline_id, source_field, target_field, position)
       values ($1, $2, 'Id', 'contact_id', 0) returning id`,
      [tenantB.tenantId, pipelineBId],
    );
    mappingBId = Number(mappingB.id);
  });

  afterAll(async () => {
    await cleanupFixture(admin, tenantA);
    await cleanupFixture(admin, tenantB);
    await cleanupFixture(admin, tenantEmployee);
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
        "is_connect_operator",
      ]],
    );
    expect(rows).toHaveLength(7);
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
       values ($1, $2::text, 'employee', encode(digest($2::text, 'sha256'), 'hex')) returning id`,
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

  it("Connect operators with multiple memberships only see the explicitly selected tenant", async () => {
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, status) values ($1, $2, 'company_admin', 'active')",
      [tenantB.tenantId, tenantA.profileId],
    );
    try {
      const rowsA = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        (c) => c.query("select id, tenant_id from public.connectors order by id").then((r) => r.rows),
      );
      expect(rowsA).toEqual([{ id: connectorAId, tenant_id: tenantA.tenantId }]);

      const rowsB = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        (c) => c.query("select id, tenant_id from public.connectors order by id").then((r) => r.rows),
      );
      expect(rowsB).toEqual([{ id: connectorBId, tenant_id: tenantB.tenantId }]);
    } finally {
      await admin.query("delete from public.tenant_memberships where tenant_id = $1 and user_id = $2", [
        tenantB.tenantId,
        tenantA.profileId,
      ]);
    }
  });

  it("published branding is member-readable but drafts remain Company Admin-only", async () => {
    const published = await withUserContext(
      { userId: tenantEmployee.profileId, tenantId: tenantEmployee.tenantId },
      (client) => client.query("select tenant_id, primary_color from public.tenant_branding").then((result) => result.rows),
    );
    expect(published).toEqual([{ tenant_id: tenantEmployee.tenantId, primary_color: "#334455" }]);

    const drafts = await withUserContext(
      { userId: tenantEmployee.profileId, tenantId: tenantEmployee.tenantId },
      (client) => client.query("select tenant_id from public.tenant_branding_drafts").then((result) => result.rows),
    );
    expect(drafts).toHaveLength(0);

    await expect(withUserContext(
      { userId: tenantEmployee.profileId, tenantId: tenantEmployee.tenantId },
      (client) => client.query(
        `insert into public.tenant_branding_drafts (tenant_id, updated_by)
         values ($1, $2)`,
        [tenantEmployee.tenantId, tenantEmployee.profileId],
      ),
    )).rejects.toThrow(/row-level security/);
  });

  it("a multi-tenant Company Admin sees and updates branding only in the selected tenant", async () => {
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, status) values ($1, $2, 'company_admin', 'active')",
      [tenantB.tenantId, tenantA.profileId],
    );
    try {
      const scopedToA = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        async (client) => {
          const published = await client.query("select tenant_id from public.tenant_branding order by tenant_id");
          const drafts = await client.query("select tenant_id from public.tenant_branding_drafts order by tenant_id");
          const crossTenantUpdate = await client.query(
            "update public.tenant_branding set primary_color = '#000000' where tenant_id = $1",
            [tenantB.tenantId],
          );
          return { published: published.rows, drafts: drafts.rows, crossTenantUpdate: crossTenantUpdate.rowCount };
        },
      );
      expect(scopedToA).toEqual({
        published: [{ tenant_id: tenantA.tenantId }],
        drafts: [{ tenant_id: tenantA.tenantId }],
        crossTenantUpdate: 0,
      });

      const scopedToB = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        (client) => client.query("select tenant_id from public.tenant_branding").then((result) => result.rows),
      );
      expect(scopedToB).toEqual([{ tenant_id: tenantB.tenantId }]);
    } finally {
      await admin.query("delete from public.tenant_memberships where tenant_id = $1 and user_id = $2", [
        tenantB.tenantId,
        tenantA.profileId,
      ]);
    }
  });

  it("pipeline mappings and immutable versions remain scoped to the selected tenant", async () => {
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, status) values ($1, $2, 'analyst', 'active')",
      [tenantB.tenantId, tenantA.profileId],
    );
    try {
      await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        async (client) => {
          const { rows: mappings } = await client.query("select id from public.pipeline_field_mappings order by id");
          expect(mappings).toEqual([{ id: String(mappingAId) }]);
          await client.query(
            `insert into public.pipeline_config_versions
               (tenant_id, pipeline_id, version_number, configuration, created_by)
             values ($1, $2, 1, '{"loadMode":"upsert"}'::jsonb, $3)`,
            [tenantA.tenantId, pipelineAId, tenantA.profileId],
          );
        },
      );

      const mappingsB = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        (client) => client.query("select id from public.pipeline_field_mappings order by id").then((result) => result.rows),
      );
      expect(mappingsB).toEqual([{ id: String(mappingBId) }]);

      await expect(withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        (client) => client.query("update public.pipeline_config_versions set change_note = 'tampered'"),
      )).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query("delete from public.tenant_memberships where tenant_id = $1 and user_id = $2", [
        tenantB.tenantId,
        tenantA.profileId,
      ]);
    }
  });

  it("Connect tables fail closed for a mismatched real user and tenant context", async () => {
    const rows = await withUserContext(
      { userId: tenantA.profileId, tenantId: tenantB.tenantId },
      (c) => c.query("select id from public.connectors where id = $1", [connectorBId]).then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  it("an employee cannot read or create Connect configuration", async () => {
    const rows = await withUserContext(
      { userId: tenantEmployee.profileId, tenantId: tenantEmployee.tenantId },
      (c) => c.query("select id from public.connectors where id = $1", [connectorEmployeeId]).then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);

    await expect(
      withUserContext(
        { userId: tenantEmployee.profileId, tenantId: tenantEmployee.tenantId },
        (c) => c.query(
          `insert into public.connectors (tenant_id, connector_type, name, created_by)
           values ($1, 'file_upload', 'Forbidden source', $2)`,
          [tenantEmployee.tenantId, tenantEmployee.profileId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("product entitlements are selected-tenant only and cannot be changed by a Company Admin", async () => {
    const tenantARows = await withUserContext(
      { userId: tenantA.profileId, tenantId: tenantA.tenantId },
      (client) => client.query(
        "select tenant_id, product_key, status from public.tenant_product_entitlements order by product_key",
      ).then((result) => result.rows),
    );
    expect(tenantARows).toEqual([
      { tenant_id: tenantA.tenantId, product_key: "canvas", status: "locked" },
      { tenant_id: tenantA.tenantId, product_key: "connect", status: "active" },
      { tenant_id: tenantA.tenantId, product_key: "pulse", status: "active" },
    ]);

    const crossTenantUpdate = await withUserContext(
      { userId: tenantA.profileId, tenantId: tenantA.tenantId },
      (client) => client.query(
        "update public.tenant_product_entitlements set status = 'active' where tenant_id = $1 and product_key = 'canvas'",
        [tenantB.tenantId],
      ).then((result) => result.rowCount),
    );
    expect(crossTenantUpdate).toBe(0);

    const ownTenantUpdate = await withUserContext(
      { userId: tenantA.profileId, tenantId: tenantA.tenantId },
      (client) => client.query(
        "update public.tenant_product_entitlements set status = 'active' where tenant_id = $1 and product_key = 'canvas'",
        [tenantA.tenantId],
      ).then((result) => result.rowCount),
    );
    expect(ownTenantUpdate).toBe(0);
  });

  it("deduplicates an unchanged source item by connector, item id, and content hash", async () => {
    const hash = "a".repeat(64);
    await admin.query(
      `insert into public.source_batches
         (tenant_id, connector_id, batch_kind, source_item_id, source_name,
          content_sha256, content_type, size_bytes, storage_key)
       values ($1, $2, 'api_extract', 'Account', 'Account extract', $3,
               'application/x-ndjson', 10, 'test/account-a.ndjson')`,
      [tenantA.tenantId, connectorAId, hash],
    );
    await expect(
      admin.query(
        `insert into public.source_batches
           (tenant_id, connector_id, batch_kind, source_item_id, source_name,
            content_sha256, content_type, size_bytes, storage_key)
         values ($1, $2, 'api_extract', 'Account', 'Account extract replay', $3,
                 'application/x-ndjson', 10, 'test/account-a-replay.ndjson')`,
        [tenantA.tenantId, connectorAId, hash],
      ),
    ).rejects.toThrow(/source_batches_connector_id_source_item_id_content_sha256_key/);
  });

  it("rejects pairing a pipeline with a batch from another connector in the same tenant", async () => {
    const { rows: [otherConnector] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, created_by)
       values ($1, 'zendesk', 'Zendesk A', $2) returning id`,
      [tenantA.tenantId, tenantA.profileId],
    );
    const { rows: [otherBatch] } = await admin.query(
      `insert into public.source_batches
         (tenant_id, connector_id, batch_kind, source_item_id, source_name,
          content_sha256, content_type, size_bytes, storage_key)
       values ($1, $2, 'api_extract', 'tickets', 'Zendesk tickets', $3,
               'application/x-ndjson', 10, 'test/zendesk.ndjson') returning id`,
      [tenantA.tenantId, otherConnector.id, "b".repeat(64)],
    );

    await expect(
      admin.query(
        `insert into public.pipeline_runs
           (tenant_id, pipeline_id, connector_id, source_batch_id, trigger_type)
         values ($1, $2, $3, $4, 'schedule')`,
        [tenantA.tenantId, pipelineAId, connectorAId, otherBatch.id],
      ),
    ).rejects.toThrow(/pipeline_runs_source_batch_id_tenant_id_connector_id_fkey/);
  });
});
