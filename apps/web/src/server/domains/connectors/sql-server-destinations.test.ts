import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { createManualFilePipeline, getManualFilePipeline, persistManualFileRun } from "./connectors";
import {
  beginSqlDestinationLoad,
  completeSqlDestinationLoad,
  configurePipelineSqlDestination,
  createSqlServerDestination,
  getPipelineSqlDestination,
  listSqlServerDestinations,
} from "./sql-server-destinations";
import { getSqlServerCredentials, listSqlServerConnectors } from "./sql-server-connectors";

describe("SQL workbench destination persistence", () => {
  const admin = getAdminPool();
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;
  let fixture: TenantFixture;
  let other: TenantFixture;

  beforeAll(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    fixture = await createTenantWithUser(admin, {
      slug: `sql-destination-${Date.now()}`,
      name: "SQL Destination Test",
      email: `sql-destination-${Date.now()}@test.local`,
    });
    other = await createTenantWithUser(admin, {
      slug: `sql-destination-other-${Date.now()}`,
      name: "SQL Destination Other",
      email: `sql-destination-other-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await cleanupFixture(admin, other);
    await admin.end();
    if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
  });

  it("binds one validated source revision to a separate encrypted destination and idempotent load ledger", async () => {
    const ids = await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const source = await createManualFilePipeline(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Daily operations file",
        loadMode: "snapshot",
        keyColumns: [],
      });
      const pipeline = await getManualFilePipeline(client, { tenantId: fixture.tenantId, pipelineId: source.pipelineId });
      const run = await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline,
        fileName: "operations.csv",
        contentType: "text/csv",
        contentSha256: "a".repeat(64),
        sizeBytes: 42,
        storageKey: `${fixture.tenantId}/test/operations.csv`,
        sourceModifiedAt: "2026-08-20T12:00:00.000Z",
        table: {
          sourceName: "operations.csv",
          sheetName: null,
          headers: ["Account Name", "Revenue", "Active"],
          rows: [
            { "Account Name": "North", Revenue: 1200.5, Active: true },
            { "Account Name": "South", Revenue: 800, Active: false },
          ],
        },
      });
      const destination = await createSqlServerDestination(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Activ8 workbench",
        connectorType: "sql_server",
        credentials: {
          server: "sql.activ8.example",
          port: 1433,
          database: "HizedWorkbench",
          username: "hized_loader",
          password: "encrypted-loader-password",
        },
        managedSchema: "hized_landing",
        serverVersion: "16.0.1000.6",
      });
      const configured = await configurePipelineSqlDestination(client, {
        tenantId: fixture.tenantId,
        pipelineId: source.pipelineId,
        connectorId: destination.connectorId,
        targetTable: "daily_operations",
        createdBy: fixture.profileId,
      });
      const unrelatedSource = await createManualFilePipeline(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Unrelated file",
        loadMode: "snapshot",
        keyColumns: [],
      });
      const unrelatedPipeline = await getManualFilePipeline(client, { tenantId: fixture.tenantId, pipelineId: unrelatedSource.pipelineId });
      const unrelatedRun = await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline: unrelatedPipeline,
        fileName: "unrelated.csv",
        contentType: "text/csv",
        contentSha256: "b".repeat(64),
        sizeBytes: 20,
        storageKey: `${fixture.tenantId}/test/unrelated.csv`,
        sourceModifiedAt: "2026-08-20T12:05:00.000Z",
        table: { sourceName: "unrelated.csv", sheetName: null, headers: ["Value"], rows: [{ Value: "other" }] },
      });
      return { ...source, ...run, ...destination, ...configured, unrelatedRunId: unrelatedRun.runId };
    });

    const first = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => beginSqlDestinationLoad(client, { tenantId: fixture.tenantId, pipelineId: ids.pipelineId }),
    );
    expect(first.alreadySucceeded).toBe(false);
    expect(first.credentials).toMatchObject({ username: "hized_loader", password: "encrypted-loader-password" });
    expect(first.fields).toEqual(expect.arrayContaining([
      { sourceField: "Account Name", targetColumn: "Account_Name", dataType: "string" },
      { sourceField: "Revenue", targetColumn: "Revenue", dataType: "numeric" },
      { sourceField: "Active", targetColumn: "Active", dataType: "boolean" },
    ]));
    expect(first.fields).toHaveLength(3);
    expect(first.records).toHaveLength(2);

    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      await completeSqlDestinationLoad(client, {
        tenantId: fixture.tenantId,
        destinationId: first.destination.id,
        sourceRunId: first.sourceRunId,
        status: "succeeded",
        rowsWritten: 2,
        message: "Loaded 2 rows",
      });
      const current = await getPipelineSqlDestination(client, { tenantId: fixture.tenantId, pipelineId: ids.pipelineId });
      expect(current).toMatchObject({ targetSchema: "hized_landing", targetTable: "daily_operations", lastLoadStatus: "succeeded", lastRowsWritten: 2 });
      const [listed] = await listSqlServerDestinations(client, { tenantId: fixture.tenantId });
      expect(listed).toMatchObject({ id: ids.connectorId, managedSchema: "hized_landing" });
      expect(await listSqlServerConnectors(client, { tenantId: fixture.tenantId })).toEqual([]);
      await expect(getSqlServerCredentials(client, { tenantId: fixture.tenantId, connectorId: ids.connectorId })).rejects.toThrow(/not found/);
    });

    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => client.query(
        `insert into public.pipeline_sql_destination_runs
           (tenant_id, destination_id, source_run_id, status, finished_at)
         values ($1, $2, $3, 'failed', now())`,
        [fixture.tenantId, first.destination.id, ids.unrelatedRunId],
      ),
    )).rejects.toThrow(/does not belong/);
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => configurePipelineSqlDestination(client, {
        tenantId: fixture.tenantId,
        pipelineId: ids.pipelineId,
        connectorId: ids.connectorId,
        targetTable: "silently_repointed",
        createdBy: fixture.profileId,
      }),
    )).rejects.toThrow(/cannot be silently repointed/);

    const repeated = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => beginSqlDestinationLoad(client, { tenantId: fixture.tenantId, pipelineId: ids.pipelineId }),
    );
    expect(repeated.alreadySucceeded).toBe(true);
    expect(repeated.records).toEqual([]);

    await expect(withUserContext(
      { userId: other.profileId, tenantId: other.tenantId },
      (client) => getPipelineSqlDestination(client, { tenantId: other.tenantId, pipelineId: ids.pipelineId }),
    )).resolves.toBeNull();
  });
});
