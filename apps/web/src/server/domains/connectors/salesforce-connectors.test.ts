import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  acquireSalesforceSyncLease,
  commitSalesforceSyncSuccess,
  createSalesforceConnector,
  createSalesforceObjectPipeline,
  getSalesforceSyncContext,
  listSalesforceConnectors,
} from "./salesforce-connectors";
import { claimDueSalesforceSyncs } from "./salesforce-scheduler";
import { persistManualFileRun } from "./connectors";

const description = {
  name: "Account",
  label: "Accounts",
  modifiedField: "SystemModstamp",
  supportsDeleted: true,
  fields: [
    { name: "Id", label: "ID", salesforceType: "id", dataType: "string" as const, nillable: false, queryable: true },
    { name: "Name", label: "Account Name", salesforceType: "string", dataType: "string" as const, nillable: true, queryable: true },
    { name: "SystemModstamp", label: "System Modstamp", salesforceType: "datetime", dataType: "timestamp" as const, nillable: false, queryable: true },
    { name: "IsDeleted", label: "Deleted", salesforceType: "boolean", dataType: "boolean" as const, nillable: false, queryable: true },
  ],
};

describe("Salesforce connector persistence", () => {
  const admin = getAdminPool();
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;
  let fixture: TenantFixture;

  beforeAll(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    fixture = await createTenantWithUser(admin, {
      slug: `salesforce-test-${Date.now()}`,
      name: "Salesforce Test",
      email: `salesforce-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.end();
    if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
  });

  it("encrypts credentials and creates an Id-upsert pipeline with a 24-hour overlap", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const connector = await createSalesforceConnector(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Activ8 Salesforce",
        credentials: {
          myDomainUrl: "https://activ8.my.salesforce.com",
          clientId: "consumer-key",
          clientSecret: "consumer-secret",
        },
        apiVersion: "67.0",
        catalog: [{ name: "Account", label: "Accounts", custom: false }],
      });
      const pipeline = await createSalesforceObjectPipeline(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        createdBy: fixture.profileId,
        pipelineName: "Salesforce accounts",
        description,
        selectedFields: ["Name"],
        apiVersion: "67.0",
        initialLookbackSeconds: 30 * 86_400,
        overlapSeconds: 86_400,
        pollIntervalMinutes: 1440,
      });
      const context = await getSalesforceSyncContext(client, {
        tenantId: fixture.tenantId,
        pipelineId: pipeline.pipelineId,
      });
      expect(context.credentials.clientSecret).toBe("consumer-secret");
      expect(context).toMatchObject({
        objectName: "Account",
        modifiedField: "SystemModstamp",
        includeDeleted: true,
        overlapSeconds: 86_400,
        initialLookbackSeconds: 30 * 86_400,
        pipeline: { loadMode: "upsert", keyColumns: ["Id"] },
      });
      expect(context.fields).toEqual(["Name", "Id", "SystemModstamp", "IsDeleted"]);

      const loaded = await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline: context.pipeline,
        fileName: "Account-2026-08-14.json",
        contentType: "application/json",
        contentSha256: "a".repeat(64),
        sizeBytes: 200,
        storageKey: `${fixture.tenantId}/connect/${connector.connectorId}/Account.json`,
        sourceModifiedAt: "2026-08-14T12:00:00.000Z",
        batchKind: "api_extract",
        windowStartedAt: "2026-08-13T12:00:00.000Z",
        windowEndedAt: "2026-08-14T12:00:00.000Z",
        deletionField: "IsDeleted",
        table: {
          sourceName: "Account",
          sheetName: null,
          headers: context.fields,
          rows: [
            { Name: "Retained account", Id: "001A", SystemModstamp: "2026-08-14T10:00:00.000Z", IsDeleted: false },
            { Name: "Deleted account", Id: "001B", SystemModstamp: "2026-08-14T11:00:00.000Z", IsDeleted: true },
          ],
        },
      });
      expect(loaded).toMatchObject({ acceptedRows: 2, rejectedRows: 0 });
      const { rows: tombstones } = await client.query(
        "select data ->> 'Id' as salesforce_id, is_deleted, deleted_at from public.curated_records where pipeline_id = $1 order by data ->> 'Id'",
        [pipeline.pipelineId],
      );
      expect(tombstones).toEqual([
        { salesforce_id: "001A", is_deleted: false, deleted_at: null },
        { salesforce_id: "001B", is_deleted: true, deleted_at: expect.any(Date) },
      ]);

      const leaseToken = await acquireSalesforceSyncLease(client, {
        tenantId: fixture.tenantId,
        pipelineId: pipeline.pipelineId,
      });
      await commitSalesforceSyncSuccess(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        pipelineId: pipeline.pipelineId,
        expectedCommittedThroughAt: null,
        committedThroughAt: "2026-08-14T12:00:00.000Z",
        leaseToken,
      });
      const [listed] = await listSalesforceConnectors(client, { tenantId: fixture.tenantId });
      expect(listed).toMatchObject({ name: "Activ8 Salesforce", apiVersion: "67.0" });
      expect(listed?.pipelines[0]).toMatchObject({
        id: pipeline.pipelineId,
        objectName: "Account",
        pollIntervalMinutes: 1440,
      });
    });
  });

  it("claims only due, active and entitled pipeline identifiers for an ordinary RLS sync", async () => {
    const created = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      async (client) => {
        const connector = await createSalesforceConnector(client, {
          tenantId: fixture.tenantId,
          createdBy: fixture.profileId,
          name: "Scheduled Salesforce",
          credentials: {
            myDomainUrl: "https://activ8.my.salesforce.com",
            clientId: "scheduled-key",
            clientSecret: "scheduled-secret",
          },
          apiVersion: "67.0",
          catalog: [{ name: "Account", label: "Accounts", custom: false }],
        });
        const pipeline = await createSalesforceObjectPipeline(client, {
          tenantId: fixture.tenantId,
          connectorId: connector.connectorId,
          createdBy: fixture.profileId,
          pipelineName: "Scheduled accounts",
          description,
          selectedFields: ["Id", "Name", "SystemModstamp", "IsDeleted"],
          apiVersion: "67.0",
          initialLookbackSeconds: null,
          overlapSeconds: 86_400,
          pollIntervalMinutes: 60,
        });
        return { connectorId: connector.connectorId, pipelineId: pipeline.pipelineId };
      },
    );
    await admin.query(
      `update public.pipeline_sync_state set next_poll_at = '2000-01-01T00:00:00Z', next_retry_at = null
       where pipeline_id = $1 and tenant_id = $2`,
      [created.pipelineId, fixture.tenantId],
    );
    const { rows: [privileges] } = await admin.query(
      `select
         has_function_privilege('public', 'public.claim_due_salesforce_syncs(integer)', 'EXECUTE') as public_execute,
         has_function_privilege('app_user', 'public.claim_due_salesforce_syncs(integer)', 'EXECUTE') as app_execute`,
    );
    expect(privileges).toEqual({ public_execute: false, app_execute: true });

    const claims = await claimDueSalesforceSyncs(20);
    const claim = claims.find((candidate) => candidate.pipelineId === created.pipelineId);
    expect(claim).toMatchObject({
      tenantId: fixture.tenantId,
      connectorId: created.connectorId,
      pipelineId: created.pipelineId,
      actorUserId: fixture.profileId,
    });
    expect(claim?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);

    await admin.query("update public.tenants set status = 'suspended' where id = $1", [fixture.tenantId]);
    await admin.query(
      `update public.pipeline_sync_state set next_poll_at = '2000-01-01T00:00:00Z', next_retry_at = null,
         lease_token = null, lease_expires_at = null where pipeline_id = $1 and tenant_id = $2`,
      [created.pipelineId, fixture.tenantId],
    );
    const suspendedClaims = await claimDueSalesforceSyncs(20);
    expect(suspendedClaims.some((candidate) => candidate.pipelineId === created.pipelineId)).toBe(false);
    await admin.query("update public.tenants set status = 'active' where id = $1", [fixture.tenantId]);
  });
});
