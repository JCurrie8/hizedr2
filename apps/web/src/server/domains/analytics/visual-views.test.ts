import { Pool } from "@neondatabase/serverless";
import { withUserContext } from "@hized/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixture, createTenantWithUser, type TenantFixture } from "@hized/testing";
import {
  addAnalyticsWidget,
  createAnalyticsView,
  duplicateAnalyticsView,
  getAnalyticsView,
  listAnalyticsSharingOptions,
  listAnalyticsViewGrants,
  loadAnalyticsViewRuntime,
  parseAnalyticsReportingPeriods,
  publishAnalyticsView,
  removeAnalyticsViewGrant,
  setAnalyticsViewGrant,
} from "./visual-views";

describe("Canvas sharing and duplication", () => {
  const admin = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  let owner: TenantFixture;
  let otherTenant: TenantFixture;
  let colleague: { profileId: string; authUserId: string; membershipId: string };
  let companyNodeId: string;
  let metricId: string;
  let adminOnlyMetricId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    owner = await createTenantWithUser(admin, {
      slug: `canvas-sharing-${stamp}`,
      name: "Canvas Sharing",
      email: `canvas-owner-${stamp}@test.local`,
    });
    otherTenant = await createTenantWithUser(admin, {
      slug: `canvas-sharing-other-${stamp}`,
      name: "Other Canvas Tenant",
      email: `canvas-other-${stamp}@test.local`,
    });
    await admin.query(
      `update public.tenant_product_entitlements
          set status = 'trial'
        where tenant_id = any($1::uuid[]) and product_key = 'canvas'`,
      [[owner.tenantId, otherTenant.tenantId]],
    );

    const { rows: [authUser] } = await admin.query<{ id: string }>(
      `insert into public."user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'Canvas Colleague', $1, true)
       returning id`,
      [`canvas-colleague-${stamp}@test.local`],
    );
    const { rows: [profile] } = await admin.query<{ id: string }>(
      `insert into public.profiles (auth_user_id, full_name)
       values ($1, 'Canvas Colleague') returning id`,
      [authUser.id],
    );
    const { rows: [membership] } = await admin.query<{ id: string }>(
      `insert into public.tenant_memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'manager', 'active') returning id`,
      [owner.tenantId, profile.id],
    );
    colleague = { profileId: profile.id, authUserId: authUser.id, membershipId: membership.id };

    const { rows: [companyNode] } = await admin.query<{ id: string }>(
      `insert into public.org_nodes (tenant_id, node_type)
       values ($1, 'company') returning id`,
      [owner.tenantId],
    );
    companyNodeId = companyNode.id;
    await admin.query(
      `insert into public.org_node_versions
         (org_node_id, tenant_id, name, path, valid_from)
       values ($1, $2, 'Canvas Sharing Company', $3::ltree, current_date)`,
      [companyNodeId, owner.tenantId, companyNodeId.replaceAll("-", "_")],
    );
    await admin.query(
      `insert into public.membership_scopes (membership_id, org_node_id, is_primary)
       values ($1, $2, true)`,
      [colleague.membershipId, companyNodeId],
    );

    const { rows: [dataset] } = await admin.query<{ id: string }>(
      `insert into public.governed_datasets
         (tenant_id, dataset_key, name, subject_area, status, refresh_cadence,
          expected_latency, created_by, updated_by)
       values ($1, 'canvas_operations', 'Canvas Operations', 'Operations',
               'published', 'Daily', interval '1 day', $2, $2)
       returning id`,
      [owner.tenantId, owner.profileId],
    );
    const { rows: [metric] } = await admin.query<{ id: string }>(
      `insert into public.kpi_definitions
         (tenant_id, dataset_id, kpi_key, version_number, name, definition,
          formula_reference, owner_name, reviewer_name, unit, favourable_direction, aggregation,
          refresh_cadence, valid_from, approval_status, approved_by, approved_at, created_by)
       values ($1, $2, 'canvas_completed_jobs', 1, 'Completed jobs',
               'Jobs completed in the reporting period.', 'count(completed_job_id)',
               'Operations Director', 'Managing Director', 'number', 'higher', 'sum', 'Daily',
               current_date, 'approved', $3, now(), $3)
       returning id`,
      [owner.tenantId, dataset.id, owner.profileId],
    );
    metricId = metric.id;
    await admin.query(
      `insert into public.kpi_values
         (tenant_id, kpi_definition_id, org_node_id, period_start, period_end,
          actual_value, target_value, prior_period_value, source_refreshed_at, calculated_by)
       select $1, $2, $3,
              current_date - ((series.period_offset + 1) * 7),
              current_date - (series.period_offset * 7),
              120 - series.period_offset, 115, 118 - series.period_offset,
              now(), $4
         from generate_series(0, 11) as series(period_offset)`,
      [owner.tenantId, metricId, companyNodeId, owner.profileId],
    );
    const { rows: [adminOnlyMetric] } = await admin.query<{ id: string }>(
      `insert into public.kpi_definitions
         (tenant_id, dataset_id, kpi_key, version_number, name, definition,
          formula_reference, owner_name, reviewer_name, unit, favourable_direction, aggregation,
          refresh_cadence, audience_roles, valid_from, approval_status, approved_by, approved_at, created_by)
       values ($1, $2, 'canvas_admin_only', 1, 'Admin-only KPI',
               'A deliberately restricted KPI used to prove duplication does not widen access.',
               'count(restricted_id)', 'Operations Director', 'Managing Director',
               'number', 'higher', 'sum', 'Daily',
               array['company_admin']::public.app_role[], current_date,
               'approved', $3, now(), $3)
       returning id`,
      [owner.tenantId, dataset.id, owner.profileId],
    );
    adminOnlyMetricId = adminOnlyMetric.id;
  });

  afterAll(async () => {
    await cleanupFixture(admin, owner);
    await admin.query("delete from public.profiles where id = $1", [colleague.profileId]);
    await admin.query(`delete from public."user" where id = $1`, [colleague.authUserId]);
    await cleanupFixture(admin, otherTenant);
    await admin.end();
  });

  async function createBoard(name: string): Promise<string> {
    return withUserContext({ userId: owner.profileId, tenantId: owner.tenantId }, async (client) => {
      const view = await createAnalyticsView(client, {
        tenantId: owner.tenantId,
        surface: "canvas",
        name,
        description: "A governed operations board.",
        actorUserId: owner.profileId,
      });
      await addAnalyticsWidget(client, {
        tenantId: owner.tenantId,
        viewId: view.id,
        title: "Completed jobs",
        subtitle: "Current governed total",
        visualType: "kpi",
        sourceMode: "current",
        width: 6,
        height: "standard",
        staticText: "",
        metricIds: [metricId],
        actorUserId: owner.profileId,
      });
      return view.id;
    });
  }

  it("lists only in-tenant people and visible organisation targets", async () => {
    const options = await withUserContext(
      { userId: owner.profileId, tenantId: owner.tenantId },
      (client) => listAnalyticsSharingOptions(client, {
        tenantId: owner.tenantId,
        actorUserId: owner.profileId,
      }),
    );
    expect(options.members).toEqual([
      expect.objectContaining({ id: colleague.membershipId, label: "Canvas Colleague" }),
    ]);
    expect(options.organisationNodes).toEqual([
      expect.objectContaining({ id: companyNodeId, label: "Canvas Sharing Company" }),
    ]);
    expect(options.roles.map((role) => role.id)).toContain("manager");
  });

  it("applies a validated global reporting window before visual data reaches the renderer", async () => {
    const viewId = await createBoard("Filtered operations");
    const runtime = await withUserContext(
      { userId: owner.profileId, tenantId: owner.tenantId },
      (client) => loadAnalyticsViewRuntime(client, {
        tenantId: owner.tenantId,
        viewId,
        reportingPeriods: 3,
      }),
    );

    expect(runtime?.filterContext).toEqual({ reportingPeriods: 3 });
    expect(runtime?.values).toHaveLength(3);
    expect(runtime?.values.map((row) => row.periodEnd)).toEqual(
      [...(runtime?.values ?? [])].map((row) => row.periodEnd).sort(),
    );
    expect(parseAnalyticsReportingPeriods("6")).toBe(6);
    expect(parseAnalyticsReportingPeriods("999")).toBe(12);
    expect(parseAnalyticsReportingPeriods("anything")).toBe(12);
  });

  it("shares a published board with a named member without widening ownership", async () => {
    const viewId = await createBoard("Named sharing");
    await withUserContext({ userId: owner.profileId, tenantId: owner.tenantId }, async (client) => {
      await setAnalyticsViewGrant(client, {
        tenantId: owner.tenantId,
        viewId,
        actorUserId: owner.profileId,
        type: "membership",
        targetId: colleague.membershipId,
        permission: "edit",
      });
      await publishAnalyticsView(client, {
        tenantId: owner.tenantId,
        viewId,
        actorUserId: owner.profileId,
        makeDefault: false,
      });
    });

    const shared = await withUserContext(
      { userId: colleague.profileId, tenantId: owner.tenantId },
      (client) => getAnalyticsView(client, { tenantId: owner.tenantId, viewId }),
    );
    expect(shared).toMatchObject({ id: viewId, isOwner: false, canEdit: true, visibility: "restricted" });

    await expect(withUserContext(
      { userId: colleague.profileId, tenantId: owner.tenantId },
      (client) => setAnalyticsViewGrant(client, {
        tenantId: owner.tenantId,
        viewId,
        actorUserId: colleague.profileId,
        type: "role",
        targetId: "employee",
        permission: "view",
      }),
    )).rejects.toThrow(/Only the board owner/);
  });

  it("duplicates a permitted board into a private copy with the same governed KPI lineage", async () => {
    const sourceViewId = await createBoard("Board to copy");
    await withUserContext({ userId: owner.profileId, tenantId: owner.tenantId }, async (client) => {
      await addAnalyticsWidget(client, {
        tenantId: owner.tenantId,
        viewId: sourceViewId,
        title: "Restricted administration metric",
        subtitle: "Not available to the Manager recipient",
        visualType: "kpi",
        sourceMode: "current",
        width: 6,
        height: "standard",
        staticText: "",
        metricIds: [adminOnlyMetricId],
        actorUserId: owner.profileId,
      });
      await setAnalyticsViewGrant(client, {
        tenantId: owner.tenantId,
        viewId: sourceViewId,
        actorUserId: owner.profileId,
        type: "membership",
        targetId: colleague.membershipId,
        permission: "view",
      });
      await publishAnalyticsView(client, {
        tenantId: owner.tenantId,
        viewId: sourceViewId,
        actorUserId: owner.profileId,
        makeDefault: false,
      });
    });

    const copy = await withUserContext(
      { userId: colleague.profileId, tenantId: owner.tenantId },
      (client) => duplicateAnalyticsView(client, {
        tenantId: owner.tenantId,
        viewId: sourceViewId,
        actorUserId: colleague.profileId,
      }),
    );
    const copiedView = await withUserContext(
      { userId: colleague.profileId, tenantId: owner.tenantId },
      (client) => getAnalyticsView(client, { tenantId: owner.tenantId, viewId: copy.id }),
    );
    expect(copiedView).toMatchObject({
      name: "Board to copy copy",
      status: "draft",
      visibility: "private",
      isOwner: true,
      widgetCount: 1,
    });
    expect(copiedView?.widgets[0]?.metrics.map((metric) => metric.id)).toEqual([metricId]);

    const ownerCannotReadCopy = await withUserContext(
      { userId: owner.profileId, tenantId: owner.tenantId },
      (client) => getAnalyticsView(client, { tenantId: owner.tenantId, viewId: copy.id }),
    );
    expect(ownerCannotReadCopy).toBeNull();
  });

  it("rejects cross-tenant targets and fails closed after the final rule is removed", async () => {
    const viewId = await createBoard("Fail-closed sharing");
    const grant = await withUserContext(
      { userId: owner.profileId, tenantId: owner.tenantId },
      (client) => setAnalyticsViewGrant(client, {
        tenantId: owner.tenantId,
        viewId,
        actorUserId: owner.profileId,
        type: "membership",
        targetId: colleague.membershipId,
        permission: "view",
      }),
    );

    const { rows: [otherMembership] } = await admin.query<{ id: string }>(
      `select id from public.tenant_memberships
        where tenant_id = $1 and user_id = $2`,
      [otherTenant.tenantId, otherTenant.profileId],
    );
    await expect(withUserContext(
      { userId: owner.profileId, tenantId: owner.tenantId },
      (client) => setAnalyticsViewGrant(client, {
        tenantId: owner.tenantId,
        viewId,
        actorUserId: owner.profileId,
        type: "membership",
        targetId: otherMembership.id,
        permission: "view",
      }),
    )).rejects.toThrow(/active member of this company/);

    await withUserContext({ userId: owner.profileId, tenantId: owner.tenantId }, async (client) => {
      await removeAnalyticsViewGrant(client, {
        tenantId: owner.tenantId,
        viewId,
        grantId: grant.id,
        actorUserId: owner.profileId,
      });
      await expect(listAnalyticsViewGrants(client, {
        tenantId: owner.tenantId,
        viewId,
        actorUserId: owner.profileId,
      })).resolves.toHaveLength(0);
      await expect(getAnalyticsView(client, { tenantId: owner.tenantId, viewId })).resolves.toMatchObject({
        visibility: "private",
      });
    });
  });
});
