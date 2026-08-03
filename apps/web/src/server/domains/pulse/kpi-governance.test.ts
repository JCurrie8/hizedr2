import { Pool } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, type TenantFixture } from "@hized/testing";
import {
  approveKpiDraft,
  createKpiDraft,
  createNextKpiVersion,
  listPublishedDatasetOptions,
} from "./kpi-governance";

describe("governed KPI authoring and approval", () => {
  const admin = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  let fixture: TenantFixture;
  let analyst: { profileId: string; authUserId: string };
  let datasetId: string;

  const draftInput = (createdBy: string, key: string) => ({
    tenantId: fixture.tenantId,
    datasetId,
    key,
    name: "Completed on time",
    definition: "Percentage of eligible jobs completed by the promised date.",
    businessPurpose: "Identify delivery risk early.",
    formulaReference: "completed_on_time / eligible_jobs",
    ownerName: "Operations Director",
    reviewerName: "Managing Director",
    unit: "percentage" as const,
    currencyCode: null,
    decimalPlaces: 1,
    favourableDirection: "higher" as const,
    aggregation: "ratio" as const,
    refreshCadence: "Daily by 07:00",
    thresholds: { green: { min: 92 }, amber: { min: 88 } },
    targetMethod: "period_specific" as const,
    permittedDimensions: ["region", "team"],
    applicableNodeTypes: ["company", "region", "team"] as const,
    audienceRoles: ["company_admin", "executive", "manager", "analyst", "employee"] as const,
    validFrom: "2026-01-01",
    createdBy,
  });

  beforeAll(async () => {
    fixture = await createTenantWithUser(admin, {
      slug: `kpi-governance-${Date.now()}`,
      name: "KPI Governance",
      email: `kpi-governance-admin-${Date.now()}@test.local`,
    });
    const { rows: [dataset] } = await admin.query(
      `insert into public.governed_datasets
         (tenant_id, dataset_key, name, subject_area, status, refresh_cadence,
          expected_latency, created_by, updated_by)
       values ($1, 'operations', 'Operations', 'Operations', 'published', 'Daily',
               interval '1 day', $2, $2) returning id`,
      [fixture.tenantId, fixture.profileId],
    );
    datasetId = dataset.id;

    const { rows: [authUser] } = await admin.query(
      `insert into "user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'KPI Analyst', $1, true) returning id`,
      [`kpi-governance-analyst-${Date.now()}@test.local`],
    );
    const { rows: [profile] } = await admin.query(
      `insert into public.profiles (auth_user_id, full_name)
       values ($1, 'KPI Analyst') returning id`,
      [authUser.id],
    );
    await admin.query(
      `insert into public.tenant_memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'analyst', 'active')`,
      [fixture.tenantId, profile.id],
    );
    analyst = { profileId: profile.id, authUserId: authUser.id };
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.query("delete from public.profiles where id = $1", [analyst.profileId]);
    await admin.query(`delete from "user" where id = $1`, [analyst.authUserId]);
    await admin.end();
  });

  it("lists only published datasets for KPI setup", async () => {
    const datasets = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => listPublishedDatasetOptions(client, { tenantId: fixture.tenantId }),
    );
    expect(datasets).toEqual([{ id: datasetId, name: "Operations", subjectArea: "Operations", refreshCadence: "Daily" }]);
  });

  it("publishes a Company Admin draft", async () => {
    const draft = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      async (client) => {
        const created = await createKpiDraft(client, draftInput(fixture.profileId, "completed_on_time"));
        await approveKpiDraft(client, { tenantId: fixture.tenantId, definitionId: created.id });
        return created;
      },
    );
    const { rows: [approved] } = await admin.query(
      "select version_number, approval_status, approved_by from public.kpi_definitions where id = $1",
      [draft.id],
    );
    expect(approved).toMatchObject({ version_number: 1, approval_status: "approved", approved_by: fixture.profileId });
  });

  it("rolls approval forward without rewriting the old version", async () => {
    const { rows: [current] } = await admin.query(
      "select id from public.kpi_definitions where tenant_id = $1 and kpi_key = 'completed_on_time' and valid_to is null",
      [fixture.tenantId],
    );
    const next = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      async (client) => {
        const created = await createNextKpiVersion(client, {
          tenantId: fixture.tenantId,
          definitionId: current.id,
          validFrom: "2026-02-01",
          createdBy: fixture.profileId,
        });
        await approveKpiDraft(client, { tenantId: fixture.tenantId, definitionId: created.id });
        return created;
      },
    );
    const { rows } = await admin.query(
      `select id, version_number, approval_status, valid_from::text, valid_to::text
       from public.kpi_definitions
       where tenant_id = $1 and kpi_key = 'completed_on_time'
       order by version_number`,
      [fixture.tenantId],
    );
    expect(next.version).toBe(2);
    expect(rows).toEqual([
      { id: current.id, version_number: 1, approval_status: "approved", valid_from: "2026-01-01", valid_to: "2026-02-01" },
      { id: next.id, version_number: 2, approval_status: "approved", valid_from: "2026-02-01", valid_to: null },
    ]);
  });

  it("lets an Analyst author a draft but not approve it", async () => {
    const draft = await withUserContext(
      { userId: analyst.profileId, tenantId: fixture.tenantId },
      (client) => createKpiDraft(client, draftInput(analyst.profileId, "analyst_draft")),
    );
    await expect(
      withUserContext(
        { userId: analyst.profileId, tenantId: fixture.tenantId },
        (client) => approveKpiDraft(client, { tenantId: fixture.tenantId, definitionId: draft.id }),
      ),
    ).rejects.toThrow(/Only a Company Admin/);
  });
});
