import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "./fixtures";

describe("SQL analysis result RLS", () => {
  const admin = getAdminPool();
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let manager: { profileId: string; authUserId: string };
  let queryId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    tenantA = await createTenantWithUser(admin, { slug: `sql-analysis-a-${stamp}`, name: "SQL Analysis A", email: `sql-analysis-a-${stamp}@test.local` });
    tenantB = await createTenantWithUser(admin, { slug: `sql-analysis-b-${stamp}`, name: "SQL Analysis B", email: `sql-analysis-b-${stamp}@test.local` });
    await admin.query(
      "update public.tenant_product_entitlements set status = 'trial' where tenant_id = any($1::uuid[]) and product_key in ('connect', 'canvas', 'pulse')",
      [[tenantA.tenantId, tenantB.tenantId]],
    );
    const { rows: [user] } = await admin.query(
      `insert into "user" (id, name, email, "emailVerified") values (gen_random_uuid()::text, 'Scoped manager', $1, true) returning id`,
      [`sql-analysis-manager-${stamp}@test.local`],
    );
    const { rows: [profile] } = await admin.query("insert into public.profiles (auth_user_id) values ($1) returning id", [user.id]);
    manager = { profileId: profile.id, authUserId: user.id };
    const { rows: [membership] } = await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, canvas_role) values ($1, $2, 'manager', 'creator') returning id",
      [tenantA.tenantId, manager.profileId],
    );
    const rootPath = "root";
    const { rows: nodes } = await admin.query(
      `insert into public.org_nodes (tenant_id, node_type, code)
       values ($1, 'company', 'COMPANY'), ($1, 'team', 'TEAM_A'), ($1, 'team', 'TEAM_B')
       returning id, code`,
      [tenantA.tenantId],
    );
    const node = (code: string) => nodes.find((candidate) => candidate.code === code).id as string;
    await admin.query(
      `insert into public.org_node_versions (org_node_id, tenant_id, parent_id, name, path, valid_from)
       values ($1, $4, null, 'Company', text2ltree($5::text), current_date - 1),
              ($2, $4, $1, 'Team A', text2ltree($5::text || '.a'), current_date - 1),
              ($3, $4, $1, 'Team B', text2ltree($5::text || '.b'), current_date - 1)`,
      [node("COMPANY"), node("TEAM_A"), node("TEAM_B"), tenantA.tenantId, rootPath],
    );
    await admin.query("insert into public.membership_scopes (membership_id, org_node_id, is_primary) values ($1, $2, true)", [membership.id, node("TEAM_A")]);
    const { rows: [connector] } = await admin.query(
      `insert into public.connectors
         (tenant_id, connector_type, name, status, auth_mode, config, created_by)
       values ($1, 'sql_server', 'Read-only reporting', 'active', 'connection_string',
               '{"direction":"source"}'::jsonb, $2) returning id`,
      [tenantA.tenantId, tenantA.profileId],
    );
    const { rows: [query] } = await admin.query(
      `insert into public.sql_analysis_queries
         (tenant_id, connector_id, name, sql_text, query_hash, status, created_by, updated_by)
       values ($1, $2, 'Scoped throughput', 'select governed result', repeat('a', 64), 'validated', $3, $3)
       returning id`,
      [tenantA.tenantId, connector.id, tenantA.profileId],
    );
    queryId = query.id;
    await admin.query(
      `insert into public.sql_analysis_rows
         (tenant_id, query_id, row_index, org_node_id, series_key, series_label,
          category_label, period_start, period_end, actual_value, source_refreshed_at)
       values ($1, $2, 0, $3, 'jobs', 'Jobs', 'Team A', current_date - 31, current_date, 12, now()),
              ($1, $2, 1, $4, 'jobs', 'Jobs', 'Team B', current_date - 31, current_date, 99, now())`,
      [tenantA.tenantId, queryId, node("TEAM_A"), node("TEAM_B")],
    );
    const { rows: [view] } = await admin.query(
      `insert into public.analytics_views
         (tenant_id, surface, name, owner_user_id, visibility, status, created_by, updated_by)
       values ($1, 'canvas', 'Scoped SQL board', $2, 'tenant', 'published', $2, $2) returning id`,
      [tenantA.tenantId, tenantA.profileId],
    );
    const { rows: [widget] } = await admin.query(
      `insert into public.analytics_widgets
         (tenant_id, view_id, title, visual_type, source_mode, position, created_by, updated_by)
       values ($1, $2, 'Jobs', 'bar', 'children', 0, $3, $3) returning id`,
      [tenantA.tenantId, view.id, tenantA.profileId],
    );
    await admin.query(
      `insert into public.analytics_widget_query_sources (tenant_id, widget_id, query_id, created_by)
       values ($1, $2, $3, $4)`,
      [tenantA.tenantId, widget.id, queryId, tenantA.profileId],
    );
  });

  afterAll(async () => {
    await cleanupFixture(admin, tenantA);
    await admin.query("delete from public.profiles where id = $1", [manager.profileId]);
    await admin.query(`delete from "user" where id = $1`, [manager.authUserId]);
    await cleanupFixture(admin, tenantB);
    await admin.end();
  });

  it("shows a published query visual through the viewer's organisation scope only", async () => {
    const result = await withUserContext({ userId: manager.profileId, tenantId: tenantA.tenantId }, async (client) => ({
      queryMetadata: await client.query("select id from public.sql_analysis_queries where id = $1", [queryId]).then((value) => value.rows),
      rows: await client.query("select category_label, actual_value::integer from public.sql_analysis_rows where query_id = $1", [queryId]).then((value) => value.rows),
    }));
    expect(result.queryMetadata).toHaveLength(0);
    expect(result.rows).toEqual([{ category_label: "Team A", actual_value: 12 }]);
  });

  it("fails closed for another tenant and for a borrowed tenant context", async () => {
    const [otherTenant, borrowedContext] = await Promise.all([
      withUserContext({ userId: tenantB.profileId, tenantId: tenantB.tenantId }, (client) => client.query("select id from public.sql_analysis_rows where query_id = $1", [queryId]).then((value) => value.rows)),
      withUserContext({ userId: tenantB.profileId, tenantId: tenantA.tenantId }, (client) => client.query("select id from public.sql_analysis_rows where query_id = $1", [queryId]).then((value) => value.rows)),
    ]);
    expect(otherTenant).toHaveLength(0);
    expect(borrowedContext).toHaveLength(0);
  });
});
