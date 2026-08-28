import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { certifySqlAnalysisSeries, createSqlAnalysisDraft, saveSqlAnalysisExecution } from "./sql-analysis";
import {
  claimSqlGatewayJob,
  completeSqlGatewayJob,
  createSqlGatewayEnrollment,
  enqueueSqlAnalysisGatewayJob,
  enrolSqlGateway,
  revokeSqlGateway,
} from "../connectors/sql-gateways";

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
    // Gateway enrolment/revocation is audited; fixture-owner cleanup must
    // explicitly clear immutable audit rows before deleting the test tenant.
    await admin.query("delete from public.audit_log where tenant_id = $1", [fixture.tenantId]);
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

  it("enrols a private gateway, leases a query, and persists its bounded result through ordinary tenant RLS", async () => {
    const enrollment = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => createSqlGatewayEnrollment(client, {
        tenantId: fixture.tenantId,
        name: "Activ8 test gateway",
        connectorName: "Activ8 private test SQL",
        actorUserId: fixture.profileId,
      }),
    );
    const enrolled = await enrolSqlGateway(enrollment.token, {
      protocolVersion: 1,
      workerVersion: "0.1.0-test",
      installationId: randomUUID(),
      machineName: "ACTIV8-SQL-TEST",
      platform: "win32 test",
      profile: {
        connectorType: "sql_server",
        server: "localhost",
        port: 1433,
        database: "Activ8Test",
        serverVersion: "16.0-test",
        catalog: [{ schema: "reporting", name: "MonthlyJobs", objectType: "view" }],
      },
    });
    const queryId = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => createSqlAnalysisDraft(client, {
        tenantId: fixture.tenantId,
        connectorId: enrolled.connectorId,
        name: "Gateway jobs completed",
        description: "Private gateway result",
        sqlText: "select 'ACTIV8' as org_code, 'gateway_jobs' as series_key, 'Gateway jobs' as series_label, cast('2026-07-01' as date) as period_start, cast('2026-08-01' as date) as period_end, 51 as actual_value",
        actorUserId: fixture.profileId,
      }),
    );
    const queuedJobId = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => enqueueSqlAnalysisGatewayJob(client, {
        tenantId: fixture.tenantId,
        queryId,
        actorUserId: fixture.profileId,
      }),
    );
    const claimed = await claimSqlGatewayJob(enrolled.deviceToken);
    expect(claimed).toMatchObject({ id: queuedJobId, kind: "sql_analysis", payload: { maxRows: 5000 } });
    await completeSqlGatewayJob(enrolled.deviceToken, claimed!.id, claimed!.leaseToken, {
      status: "succeeded",
      execution: {
        signature: [
          { name: "org_code", sqlType: "NVarChar" },
          { name: "series_key", sqlType: "NVarChar" },
          { name: "series_label", sqlType: "NVarChar" },
          { name: "period_start", sqlType: "Date" },
          { name: "period_end", sqlType: "Date" },
          { name: "actual_value", sqlType: "Int" },
        ],
        rows: [{
          orgNodeId: null,
          orgCode: "ACTIV8",
          seriesKey: "gateway_jobs",
          seriesLabel: "Gateway jobs",
          categoryLabel: "",
          periodStart: "2026-07-01",
          periodEnd: "2026-08-01",
          actualValue: 51,
          targetValue: null,
          priorPeriodValue: null,
          numeratorValue: null,
          denominatorValue: null,
          sourceRefreshedAt: "2026-08-01T06:00:00.000Z",
        }],
      },
    });
    const state = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      async (client) => ({
        query: await client.query(
          "select last_run_status, last_row_count from public.sql_analysis_queries where id = $1",
          [queryId],
        ).then((result) => result.rows[0]),
        job: await client.query(
          "select status, attempt_count, result_row_count from public.connector_gateway_jobs where id = $1",
          [queuedJobId],
        ).then((result) => result.rows[0]),
        row: await client.query(
          "select actual_value::integer from public.sql_analysis_rows where query_id = $1",
          [queryId],
        ).then((result) => result.rows[0]),
      }),
    );
    expect(state).toEqual({
      query: { last_run_status: "succeeded", last_row_count: 1 },
      job: { status: "succeeded", attempt_count: 1, result_row_count: 1 },
      row: { actual_value: 51 },
    });
    await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => revokeSqlGateway(client, {
        tenantId: fixture.tenantId,
        gatewayId: enrolled.gatewayId,
        actorUserId: fixture.profileId,
      }),
    );
    await expect(claimSqlGatewayJob(enrolled.deviceToken)).rejects.toThrow(/authentication failed/i);
  });
});
