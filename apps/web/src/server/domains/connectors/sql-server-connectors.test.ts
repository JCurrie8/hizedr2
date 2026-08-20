import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  commitSqlServerCheckpoint,
  createSqlServerConnector,
  createSqlServerPipeline,
  getSqlServerSyncContext,
  listSqlServerConnectors,
} from "./sql-server-connectors";

const description = {
  schema: "dw",
  name: "SalesforceAccount",
  objectType: "table" as const,
  fields: [
    { name: "Id", sqlType: "nvarchar", dataType: "string" as const, nullable: false, primaryKey: true, supported: true },
    { name: "Name", sqlType: "nvarchar", dataType: "string" as const, nullable: true, primaryKey: false, supported: true },
    { name: "SystemModstamp", sqlType: "datetime2", dataType: "timestamp" as const, nullable: false, primaryKey: false, supported: true },
  ],
};

describe("SQL Server connector persistence", () => {
  const admin = getAdminPool();
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;
  let fixture: TenantFixture;

  beforeAll(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    fixture = await createTenantWithUser(admin, {
      slug: `sql-server-test-${Date.now()}`,
      name: "SQL Server Test",
      email: `sql-server-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.end();
    if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
  });

  it("encrypts a read-only login and creates a governed watermark pipeline", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const connector = await createSqlServerConnector(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Activ8 warehouse",
        connectorType: "sql_server",
        credentials: {
          server: "sql.activ8.example",
          port: 1433,
          database: "Reporting",
          username: "hized_reader",
          password: "not-returned-to-ui",
        },
        serverVersion: "16.0.1000.6",
        catalog: [{ schema: "dw", name: "SalesforceAccount", objectType: "table" }],
      });
      const pipeline = await createSqlServerPipeline(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        createdBy: fixture.profileId,
        pipelineName: "Warehouse Salesforce accounts",
        description,
        selectedFields: ["Name"],
        keyColumns: ["Id"],
        watermarkField: "SystemModstamp",
        loadMode: "upsert",
        overlapSeconds: 86_400,
      });
      const context = await getSqlServerSyncContext(client, { tenantId: fixture.tenantId, pipelineId: pipeline.pipelineId });
      expect(context.credentials).toMatchObject({ username: "hized_reader", password: "not-returned-to-ui" });
      expect(context).toMatchObject({
        schema: "dw",
        object: "SalesforceAccount",
        fields: ["Name", "Id", "SystemModstamp"],
        watermarkField: "SystemModstamp",
        overlapSeconds: 86_400,
        pipeline: { loadMode: "upsert", keyColumns: ["Id"] },
      });

      await commitSqlServerCheckpoint(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        pipelineId: pipeline.pipelineId,
        expected: null,
        committedThroughAt: "2026-08-20T12:00:00.000Z",
      });
      const [listed] = await listSqlServerConnectors(client, { tenantId: fixture.tenantId });
      expect(listed).toMatchObject({
        name: "Activ8 warehouse",
        server: "sql.activ8.example",
        database: "Reporting",
        catalog: [{ schema: "dw", name: "SalesforceAccount", objectType: "table" }],
      });
      expect(listed?.pipelines[0]).toMatchObject({ id: pipeline.pipelineId, schema: "dw", object: "SalesforceAccount" });

      const { rows: [secret] } = await client.query(
        "select encode(ciphertext, 'hex') as ciphertext_hex from public.connector_credentials where connector_id = $1",
        [connector.connectorId],
      );
      expect(secret.ciphertext_hex).not.toContain(Buffer.from("not-returned-to-ui").toString("hex"));
    });
  });
});
