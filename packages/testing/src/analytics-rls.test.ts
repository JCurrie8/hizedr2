import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "./fixtures";

describe("analytics view RLS", () => {
  const admin = getAdminPool();
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let colleague: { profileId: string; authUserId: string };
  let privateViewId: string;
  let colleagueViewId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    tenantA = await createTenantWithUser(admin, { slug: `analytics-a-${stamp}`, name: "Analytics A", email: `analytics-a-${stamp}@test.local` });
    tenantB = await createTenantWithUser(admin, { slug: `analytics-b-${stamp}`, name: "Analytics B", email: `analytics-b-${stamp}@test.local` });
    await admin.query("update public.tenant_product_entitlements set status = 'trial' where tenant_id = any($1::uuid[]) and product_key = 'canvas'", [[tenantA.tenantId, tenantB.tenantId]]);
    const { rows: [user] } = await admin.query(`insert into "user" (id, name, email, "emailVerified") values (gen_random_uuid()::text, 'Canvas colleague', $1, true) returning id`, [`canvas-colleague-${stamp}@test.local`]);
    const { rows: [profile] } = await admin.query("insert into public.profiles (auth_user_id) values ($1) returning id", [user.id]);
    await admin.query("insert into public.tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'employee')", [tenantA.tenantId, profile.id]);
    colleague = { profileId: profile.id, authUserId: user.id };

    privateViewId = await withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, async (client) => {
      const { rows: [view] } = await client.query(
        `insert into public.analytics_views
           (tenant_id, surface, name, owner_user_id, created_by, updated_by)
         values ($1, 'canvas', 'Private board', $2, $2, $2)
         returning id`,
        [tenantA.tenantId, tenantA.profileId],
      );
      await client.query(
        `insert into public.analytics_widgets
           (tenant_id, view_id, title, visual_type, source_mode, position, static_text, created_by, updated_by)
         values ($1, $2, 'Context', 'text', 'current', 0, 'Private context', $3, $3)`,
        [tenantA.tenantId, view.id, tenantA.profileId],
      );
      return view.id as string;
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, tenantA);
    await admin.query("delete from public.profiles where id = $1", [colleague.profileId]);
    await admin.query(`delete from "user" where id = $1`, [colleague.authUserId]);
    await cleanupFixture(admin, tenantB);
    await admin.end();
  });

  it("does not expose a private board to a colleague or another tenant", async () => {
    const [sameTenantRows, otherTenantRows] = await Promise.all([
      withUserContext({ userId: colleague.profileId, tenantId: tenantA.tenantId }, (client) => client.query("select id from public.analytics_views where id = $1", [privateViewId]).then((result) => result.rows)),
      withUserContext({ userId: tenantB.profileId, tenantId: tenantB.tenantId }, (client) => client.query("select id from public.analytics_views where id = $1", [privateViewId]).then((result) => result.rows)),
    ]);
    expect(sameTenantRows).toHaveLength(0);
    expect(otherTenantRows).toHaveLength(0);
  });

  it("shares a published tenant board layout while retaining tenant isolation", async () => {
    await withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      "update public.analytics_views set visibility = 'tenant', status = 'published', updated_by = $2 where id = $1",
      [privateViewId, tenantA.profileId],
    ));
    const visible = await withUserContext({ userId: colleague.profileId, tenantId: tenantA.tenantId }, async (client) => ({
      views: await client.query("select id from public.analytics_views where id = $1", [privateViewId]).then((result) => result.rows),
      widgets: await client.query("select title from public.analytics_widgets where view_id = $1", [privateViewId]).then((result) => result.rows),
    }));
    expect(visible.views).toHaveLength(1);
    expect(visible.widgets).toEqual([{ title: "Context" }]);
    const crossTenant = await withUserContext({ userId: tenantB.profileId, tenantId: tenantA.tenantId }, (client) => client.query("select id from public.analytics_views where id = $1", [privateViewId]).then((result) => result.rows));
    expect(crossTenant).toHaveLength(0);
  });

  it("lets an employee create Canvas but not Pulse", async () => {
    await expect(withUserContext({ userId: colleague.profileId, tenantId: tenantA.tenantId }, async (client) => {
      const { rows: [created] } = await client.query(
      `insert into public.analytics_views (tenant_id, surface, name, owner_user_id, created_by, updated_by)
       values ($1, 'canvas', 'My board', $2, $2, $2) returning id`,
      [tenantA.tenantId, colleague.profileId],
      );
      colleagueViewId = created.id;
      return created.id;
    })).resolves.toBeDefined();
    await expect(withUserContext({ userId: colleague.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      `insert into public.analytics_views (tenant_id, surface, name, owner_user_id, created_by, updated_by)
       values ($1, 'pulse', 'Forbidden Pulse', $2, $2, $2)`,
      [tenantA.tenantId, colleague.profileId],
    ))).rejects.toThrow(/row-level security/);
  });

  it("keeps record projection rules inside the selected tenant and away from ordinary members", async () => {
    const datasetId = await withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, async (client) => {
      const { rows: [dataset] } = await client.query(
        `insert into public.governed_datasets
           (tenant_id, dataset_key, name, subject_area, status, refresh_cadence,
            expected_latency, created_by, updated_by)
         values ($1, 'projection_rls', 'Projection RLS', 'Operations', 'published', 'daily',
                 interval '1 day', $2, $2)
         returning id`,
        [tenantA.tenantId, tenantA.profileId],
      );
      await client.query(
        `insert into public.governed_dataset_fields
           (tenant_id, dataset_id, field_key, source_field, name, data_type, field_role, is_sensitive)
         values ($1, $2, 'team_code', 'Team Code', 'Team code', 'text', 'dimension', false),
                ($1, $2, 'completed_on', 'Completed On', 'Completed on', 'date', 'time', false),
                ($1, $2, 'engineer_email', 'Engineer Email', 'Engineer email', 'text', 'dimension', true)`,
        [tenantA.tenantId, dataset.id],
      );
      await client.query(
        `insert into public.governed_record_projection_rules
           (tenant_id, dataset_id, org_code_field_key, occurred_at_field_key,
            projected_field_keys, created_by, updated_by)
         values ($1, $2, 'team_code', 'completed_on', array['team_code']::text[], $3, $3)`,
        [tenantA.tenantId, dataset.id, tenantA.profileId],
      );
      return dataset.id as string;
    });

    // A sensitive field can never enter the rule, even by direct SQL.
    await expect(withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      `update public.governed_record_projection_rules
          set projected_field_keys = array['team_code', 'engineer_email']::text[], updated_by = $2
        where tenant_id = $1 and dataset_id = $3`,
      [tenantA.tenantId, tenantA.profileId, datasetId],
    ))).rejects.toThrow(/engineer_email/);

    const [memberRows, otherTenantRows, borrowedContextRows] = await Promise.all([
      withUserContext({ userId: colleague.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
        "select id from public.governed_record_projection_rules where dataset_id = $1", [datasetId],
      ).then((result) => result.rows)),
      withUserContext({ userId: tenantB.profileId, tenantId: tenantB.tenantId }, (client) => client.query(
        "select id from public.governed_record_projection_rules where dataset_id = $1", [datasetId],
      ).then((result) => result.rows)),
      withUserContext({ userId: tenantB.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
        "select id from public.governed_record_projection_rules where dataset_id = $1", [datasetId],
      ).then((result) => result.rows)),
    ]);
    expect(memberRows).toHaveLength(0);
    expect(otherTenantRows).toHaveLength(0);
    expect(borrowedContextRows).toHaveLength(0);
  });

  it("does not give a KPI governor implicit access to someone else's private Canvas board", async () => {
    const rows = await withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) =>
      client.query("select id from public.analytics_views where id = $1", [colleagueViewId]).then((result) => result.rows));
    expect(rows).toHaveLength(0);
  });
});
