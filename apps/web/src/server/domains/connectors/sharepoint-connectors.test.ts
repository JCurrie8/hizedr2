import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  commitSharePointSyncSuccess,
  configureMicrosoftWorkbookPipeline,
  createMicrosoftConnector,
  getSharePointSyncContext,
  listMicrosoftConnectors,
  recordSharePointSyncFailure,
} from "./sharepoint-connectors";

describe("SharePoint connector persistence", () => {
  const admin = getAdminPool();
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;
  let fixture: TenantFixture;

  beforeAll(async () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    fixture = await createTenantWithUser(admin, {
      slug: `sharepoint-test-${Date.now()}`,
      name: "SharePoint Test",
      email: `sharepoint-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.end();
    if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
  });

  it("stores encrypted credentials, a selected workbook and a final delta checkpoint", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const connector = await createMicrosoftConnector(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Forms workbook",
        account: { id: "microsoft-user", displayName: "Test User", email: "test@example.com" },
        credentials: {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: "2026-08-03T12:00:00.000Z",
          scope: "Files.Read.All Sites.Read.All",
          tokenType: "Bearer",
        },
      });
      const pipeline = await configureMicrosoftWorkbookPipeline(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        createdBy: fixture.profileId,
        pipelineName: "Forms responses",
        loadMode: "upsert",
        keyColumns: ["Response ID"],
        source: {
          sourceKind: "sharepoint",
          siteId: "site",
          driveId: "drive",
          driveItemId: "item",
          sourceName: "responses.xlsx",
          sourcePath: "https://example.sharepoint.com/responses.xlsx",
          sourceETag: "etag",
          sourceCTag: "ctag",
          sourceModifiedAt: "2026-08-03T10:00:00.000Z",
          sizeBytes: 500,
        },
      });
      const context = await getSharePointSyncContext(client, {
        tenantId: fixture.tenantId,
        pipelineId: pipeline.pipelineId,
      });
      expect(context.credentials.refreshToken).toBe("refresh");
      expect(context.source).toMatchObject({ driveId: "drive", driveItemId: "item", sourceKind: "sharepoint" });

      const deltaLink = "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=complete";
      await commitSharePointSyncSuccess(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        pipelineId: pipeline.pipelineId,
        deltaLink,
      });
      const listed = await listMicrosoftConnectors(client, { tenantId: fixture.tenantId });
      expect(listed[0]).toMatchObject({ pipelineId: pipeline.pipelineId, sourceName: "responses.xlsx", lastError: null });
      const { rows: [checkpoint] } = await client.query(
        `select cursor_value ->> 'deltaLink' as delta_link from public.pipeline_checkpoints
         where pipeline_id = $1 and tenant_id = $2`,
        [pipeline.pipelineId, fixture.tenantId],
      );
      expect(checkpoint.delta_link).toBe(deltaLink);

      await recordSharePointSyncFailure(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        message: "Graph temporarily unavailable",
      });
      const { rows: [retry] } = await client.query(
        `select consecutive_failures, next_retry_at from public.connector_sync_state
         where connector_id = $1 and tenant_id = $2`,
        [connector.connectorId, fixture.tenantId],
      );
      expect(retry.consecutive_failures).toBe(1);
      expect(retry.next_retry_at).toBeTruthy();
    });
  });
});
