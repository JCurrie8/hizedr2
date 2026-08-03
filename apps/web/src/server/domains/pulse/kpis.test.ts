import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { listPulseKpiCards, targetState } from "./kpis";

describe("governed Pulse KPI cards", () => {
  const admin = getAdminPool();
  let fixture: TenantFixture;
  let manager: { profileId: string; authUserId: string };
  let teamAId: string;

  beforeAll(async () => {
    const suffix = Date.now();
    fixture = await createTenantWithUser(admin, {
      slug: `pulse-kpis-${suffix}`,
      name: "Pulse KPI Test",
      email: `pulse-kpis-admin-${suffix}@test.local`,
    });

    const { rows: [company] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'company', 'PK-COMPANY') returning id",
      [fixture.tenantId],
    );
    const { rows: [teamA] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'team', 'PK-A') returning id",
      [fixture.tenantId],
    );
    const { rows: [teamB] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'team', 'PK-B') returning id",
      [fixture.tenantId],
    );
    teamAId = teamA.id;
    await admin.query(
      `insert into public.org_node_versions
         (org_node_id, tenant_id, parent_id, name, path, valid_from)
       values
         ($1, $4, null, 'KPI Company', 'kpi_company', current_date),
         ($2, $4, $1, 'Team A', 'kpi_company.team_a', current_date),
         ($3, $4, $1, 'Team B', 'kpi_company.team_b', current_date)`,
      [company.id, teamA.id, teamB.id, fixture.tenantId],
    );

    const { rows: [authUser] } = await admin.query(
      `insert into "user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'KPI Manager', $1, true) returning id`,
      [`pulse-kpis-manager-${suffix}@test.local`],
    );
    const { rows: [profile] } = await admin.query(
      "insert into public.profiles (auth_user_id, full_name) values ($1, 'KPI Manager') returning id",
      [authUser.id],
    );
    const { rows: [membership] } = await admin.query(
      `insert into public.tenant_memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'manager', 'active') returning id`,
      [fixture.tenantId, profile.id],
    );
    await admin.query(
      "insert into public.membership_scopes (membership_id, org_node_id, is_primary) values ($1, $2, true)",
      [membership.id, teamA.id],
    );
    manager = { profileId: profile.id, authUserId: authUser.id };

    const { rows: [dataset] } = await admin.query(
      `insert into public.governed_datasets
         (tenant_id, dataset_key, name, subject_area, status, refresh_cadence,
          expected_latency, last_refreshed_at, created_by, updated_by)
       values ($1, 'installation_performance', 'Installation performance', 'Operations',
               'published', 'Daily by 07:00', interval '1 day', now(), $2, $2)
       returning id`,
      [fixture.tenantId, fixture.profileId],
    );
    const { rows: [approved] } = await admin.query(
      `insert into public.kpi_definitions
         (tenant_id, dataset_id, kpi_key, version_number, name, definition,
          formula_reference, owner_name, unit, decimal_places, favourable_direction,
          aggregation, refresh_cadence, audience_roles, valid_from, approval_status,
          approved_by, approved_at, created_by)
       values ($1, $2, 'first_time_completion', 1, 'First-time completion',
               'Completed jobs without a repeat visit.', 'first_time / completed',
               'Head of Operations', 'percentage', 1, 'higher', 'ratio', 'Daily',
               enum_range(null::public.app_role), current_date - 30, 'approved', $3, now(), $3)
       returning id`,
      [fixture.tenantId, dataset.id, fixture.profileId],
    );
    const { rows: [executiveOnly] } = await admin.query(
      `insert into public.kpi_definitions
         (tenant_id, dataset_id, kpi_key, version_number, name, definition,
          formula_reference, owner_name, unit, favourable_direction, aggregation,
          refresh_cadence, audience_roles, valid_from, approval_status,
          approved_by, approved_at, created_by)
       values ($1, $2, 'commercial_margin', 1, 'Commercial margin', 'Approved margin.',
               'margin / revenue', 'Finance Director', 'percentage', 'higher', 'ratio',
               'Daily', array['executive']::public.app_role[], current_date - 30,
               'approved', $3, now(), $3)
       returning id`,
      [fixture.tenantId, dataset.id, fixture.profileId],
    );

    for (const [orgNodeId, actual] of [[company.id, 91.2], [teamA.id, 90.5], [teamB.id, 94.1]] as const) {
      await admin.query(
        `insert into public.kpi_values
           (tenant_id, kpi_definition_id, org_node_id, period_start, period_end,
            actual_value, target_value, prior_period_value, numerator_value,
            denominator_value, source_refreshed_at, calculated_by)
         values ($1, $2, $3, current_date - 7, current_date, $4, 92, 89.7,
                 $4, 100, now(), $5)`,
        [fixture.tenantId, approved.id, orgNodeId, actual, fixture.profileId],
      );
    }
    await admin.query(
      `insert into public.kpi_values
         (tenant_id, kpi_definition_id, org_node_id, period_start, period_end,
          actual_value, target_value, source_refreshed_at, calculated_by)
       values ($1, $2, $3, current_date - 7, current_date, 31.5, 30, now(), $4)`,
      [fixture.tenantId, executiveOnly.id, teamA.id, fixture.profileId],
    );
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.query("delete from public.profiles where id = $1", [manager.profileId]);
    await admin.query(`delete from "user" where id = $1`, [manager.authUserId]);
    await admin.end();
  });

  it("returns a Company Admin's latest company-level KPI", async () => {
    const cards = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => listPulseKpiCards(client, { tenantId: fixture.tenantId }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "first_time_completion",
      actualValue: 91.2,
      targetValue: 92,
      organisation: { name: "KPI Company" },
      freshness: { status: "fresh" },
    });
    expect(cards[0]?.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cards[0]?.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(cards[0]?.freshness.sourceRefreshedAt ?? ""))).toBe(false);
  });

  it("uses the manager's primary scope and filters an executive-only KPI", async () => {
    const cards = await withUserContext(
      { userId: manager.profileId, tenantId: fixture.tenantId },
      (client) => listPulseKpiCards(client, { tenantId: fixture.tenantId }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "first_time_completion",
      actualValue: 90.5,
      organisation: { id: teamAId, name: "Team A" },
    });
  });

  it("fails closed for a mismatched user and tenant context", async () => {
    const other = await createTenantWithUser(admin, {
      slug: `pulse-kpis-other-${Date.now()}`,
      name: "Other KPI Tenant",
      email: `pulse-kpis-other-${Date.now()}@test.local`,
    });
    try {
      const cards = await withUserContext(
        { userId: manager.profileId, tenantId: other.tenantId },
        (client) => listPulseKpiCards(client, { tenantId: other.tenantId }),
      );
      expect(cards).toEqual([]);
    } finally {
      await cleanupFixture(admin, other);
    }
  });
});

describe("targetState", () => {
  it("respects the declared favourable direction", () => {
    expect(targetState({ actualValue: 93, targetValue: 92, favourableDirection: "higher" })).toBe("on_track");
    expect(targetState({ actualValue: 6, targetValue: 5, favourableDirection: "lower" })).toBe("off_track");
    expect(targetState({ actualValue: 10, targetValue: null, favourableDirection: "target" })).toBe("no_target");
  });
});
