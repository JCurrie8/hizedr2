import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { createManualFilePipeline } from "../connectors/connectors";
import { getPulseHomeSnapshot } from "./home";

describe("Pulse home snapshot", () => {
  const admin = getAdminPool();
  let fixture: TenantFixture;

  beforeAll(async () => {
    fixture = await createTenantWithUser(admin, {
      slug: `pulse-home-${Date.now()}`,
      name: "Pulse Home Test",
      email: `pulse-home-${Date.now()}@test.local`,
    });
    const { rows: [company] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'company', 'PH-COMPANY') returning id",
      [fixture.tenantId],
    );
    const { rows: [team] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'team', 'PH-TEAM') returning id",
      [fixture.tenantId],
    );
    await admin.query(
      `insert into public.org_node_versions
         (org_node_id, tenant_id, parent_id, name, path, valid_from)
       values
         ($1, $3, null, 'Pulse Company', 'pulse_company', current_date),
         ($2, $3, $1, 'Pulse Team', 'pulse_company.pulse_team', current_date)`,
      [company.id, team.id, fixture.tenantId],
    );
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.end();
  });

  it("returns scoped organisation counts without exposing Connect health", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const snapshot = await getPulseHomeSnapshot(client, {
        tenantId: fixture.tenantId,
        includeConnectHealth: false,
      });
      expect(snapshot).toEqual({
        organisation: { visibleNodes: 2, teams: 1, employees: 0 },
        kpis: [],
        connect: null,
      });
    });
  });

  it("summarises real pipeline state for an authorised Connect operator", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      await createManualFilePipeline(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Pulse source",
        loadMode: "snapshot",
        keyColumns: [],
      });
      const snapshot = await getPulseHomeSnapshot(client, {
        tenantId: fixture.tenantId,
        includeConnectHealth: true,
      });
      expect(snapshot.organisation).toEqual({ visibleNodes: 2, teams: 1, employees: 0 });
      expect(snapshot.kpis).toEqual([]);
      expect(snapshot.connect).toMatchObject({
        pipelineCount: 1,
        failedRuns: 0,
        warningRuns: 0,
        recentRowsAccepted: 0,
        latestRunAt: null,
      });
      expect(snapshot.connect?.connectors).toHaveLength(1);
      expect(snapshot.connect?.recentRuns).toEqual([]);
    });
  });
});
