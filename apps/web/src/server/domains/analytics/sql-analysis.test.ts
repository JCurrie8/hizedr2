import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { certifySqlAnalysisSeries, createSqlAnalysisDraft, saveSqlAnalysisExecution } from "./sql-analysis";

describe("SQL analysis certification", () => {
  const admin = getAdminPool();
  let fixture: TenantFixture;
  let connectorId: string;
  let orgNodeId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    fixture = await createTenantWithUser(admin, {
      slug: `sql-cert-${stamp}`,
      name: "SQL certification",
      email: `sql-cert-${stamp}@test.local`,
    });
    await admin.query(
      "update public.tenant_product_entitlements set status = 'trial' where tenant_id = $1 and product_key in ('connect', 'canvas', 'pulse')",
      [fixture.tenantId],
    );
    const { rows: [node] } = await admin.query(
      "insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'company', 'ACTIV8') returning id",
      [fixture.tenantId],
    );
    orgNodeId = node.id;
    await admin.query(
      `insert into public.org_node_versions (org_node_id, tenant_id, name, path, valid_from)
       values ($1, $2, 'Activ8', 'root'::ltree, current_date - 365)`,
      [orgNodeId, fixture.tenantId],
    );
    const { rows: [connector] } = await admin.query(
      `insert into public.connectors
         (tenant_id, connector_type, name, status, auth_mode, config, created_by)
       values ($1, 'sql_server', 'Activ8 reporting', 'active', 'connection_string',
               '{"direction":"source"}'::jsonb, $2) returning id`,
      [fixture.tenantId, fixture.profileId],
    );
    connectorId = connector.id;
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.end();
  });

  it("stores a scoped result, certifies it once, and refreshes the governed KPI value", async () => {
    const queryId = await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, (client) =>
      createSqlAnalysisDraft(client, {
        tenantId: fixture.tenantId, connectorId, name: "Jobs completed", description: "Completed work",
        sqlText: "select governed jobs", actorUserId: fixture.profileId,
      }));
    const execution = (value: number) => ({
      signature: [{ name: "actual_value", sqlType: "number" }],
      rows: [{
        orgNodeId: null, orgCode: "ACTIV8", seriesKey: "jobs_completed", seriesLabel: "Jobs completed",
        categoryLabel: "", periodStart: "2026-07-01", periodEnd: "2026-08-01",
        actualValue: value, targetValue: 35, priorPeriodValue: 31,
        numeratorValue: null, denominatorValue: null, sourceRefreshedAt: "2026-08-01T06:00:00.000Z",
      }],
    });
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, (client) =>
      saveSqlAnalysisExecution(client, {
        tenantId: fixture.tenantId, queryId, actorUserId: fixture.profileId, execution: execution(37),
      }));
    const certified = await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, (client) =>
      certifySqlAnalysisSeries(client, {
        tenantId: fixture.tenantId, queryId, seriesKey: "jobs_completed", kpiKey: "jobs_completed",
        name: "Jobs completed", definition: "Completed installation jobs in the reporting period.",
        businessPurpose: "Track operational throughput.", ownerName: "Operations Director",
        unit: "number", currencyCode: null, decimalPlaces: 0, favourableDirection: "higher",
        aggregation: "sum", audienceRoles: ["company_admin", "manager", "employee"],
        actorUserId: fixture.profileId,
      }));
    const initial = await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, (client) =>
      client.query(
        `select definition.approval_status, value.actual_value::integer
           from public.kpi_definitions definition
           join public.kpi_values value on value.kpi_definition_id = definition.id and value.tenant_id = definition.tenant_id
          where definition.tenant_id = $1 and definition.id = $2 and value.org_node_id = $3`,
        [fixture.tenantId, certified.kpiDefinitionId, orgNodeId],
      ).then((result) => result.rows[0]));
    expect(initial).toEqual({ approval_status: "approved", actual_value: 37 });

    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, (client) =>
      saveSqlAnalysisExecution(client, {
        tenantId: fixture.tenantId, queryId, actorUserId: fixture.profileId, execution: execution(42),
      }));
    const refreshed = await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, (client) =>
      client.query("select actual_value::integer from public.kpi_values where tenant_id = $1 and kpi_definition_id = $2", [fixture.tenantId, certified.kpiDefinitionId]).then((result) => result.rows));
    expect(refreshed).toEqual([{ actual_value: 42 }]);
  });
});
