import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  acquireSharePointSyncLease,
  commitSharePointSyncSuccess,
  configureMicrosoftWorkbookPipeline,
  createMicrosoftConnector,
  getSharePointSyncContext,
  listMicrosoftConnectors,
  recordSharePointSyncFailure,
} from "./sharepoint-connectors";
import { claimDueSharePointSyncs } from "./sharepoint-scheduler";

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
      const firstLease = await acquireSharePointSyncLease(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
      });
      await commitSharePointSyncSuccess(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        pipelineId: pipeline.pipelineId,
        deltaLink,
        expectedDeltaLink: null,
        leaseToken: firstLease,
      });
      const listed = await listMicrosoftConnectors(client, { tenantId: fixture.tenantId });
      expect(listed[0]).toMatchObject({ pipelineId: pipeline.pipelineId, sourceName: "responses.xlsx", lastError: null });
      const { rows: [checkpoint] } = await client.query(
        `select cursor_value ->> 'deltaLink' as delta_link from public.pipeline_checkpoints
         where pipeline_id = $1 and tenant_id = $2`,
        [pipeline.pipelineId, fixture.tenantId],
      );
      expect(checkpoint.delta_link).toBe(deltaLink);

      const failureLease = await acquireSharePointSyncLease(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
      });
      await expect(commitSharePointSyncSuccess(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        pipelineId: pipeline.pipelineId,
        deltaLink: "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=stale-run",
        expectedDeltaLink: null,
        leaseToken: failureLease,
      })).rejects.toThrow(/checkpoint changed/);
      await recordSharePointSyncFailure(client, {
        tenantId: fixture.tenantId,
        connectorId: connector.connectorId,
        message: "Graph temporarily unavailable",
        leaseToken: failureLease,
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

  it("leases one due cross-tenant job but returns only IDs for an ordinary RLS sync", async () => {
    const created = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      async (client) => {
        const connector = await createMicrosoftConnector(client, {
          tenantId: fixture.tenantId,
          createdBy: fixture.profileId,
          name: "Scheduled Forms workbook",
          account: { id: "scheduled-user", displayName: "Scheduled User", email: "scheduled@example.com" },
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
          pipelineName: "Scheduled Forms responses",
          loadMode: "upsert",
          keyColumns: ["Response ID"],
          source: {
            sourceKind: "onedrive",
            siteId: null,
            driveId: "scheduled-drive",
            driveItemId: "scheduled-item",
            sourceName: "scheduled.xlsx",
            sourcePath: "https://example.sharepoint.com/scheduled.xlsx",
            sourceETag: null,
            sourceCTag: null,
            sourceModifiedAt: null,
            sizeBytes: 500,
          },
        });
        return { ...connector, ...pipeline };
      },
    );
    await admin.query(
      `update public.connector_sync_state set next_poll_at = '2000-01-01T00:00:00Z', next_retry_at = null
       where connector_id = $1 and tenant_id = $2`,
      [created.connectorId, fixture.tenantId],
    );
    const { rows: [privileges] } = await admin.query(
      `select
         has_function_privilege('public', 'public.claim_due_sharepoint_syncs(integer)', 'EXECUTE') as public_execute,
         has_function_privilege('app_user', 'public.claim_due_sharepoint_syncs(integer)', 'EXECUTE') as app_execute`,
    );
    expect(privileges).toEqual({ public_execute: false, app_execute: true });

    const [claim] = await claimDueSharePointSyncs(1);
    expect(claim).toMatchObject({
      tenantId: fixture.tenantId,
      connectorId: created.connectorId,
      pipelineId: created.pipelineId,
      actorUserId: fixture.profileId,
    });
    expect(claim?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);

    await admin.query(
      `update public.tenants set status = 'suspended' where id = $1`,
      [fixture.tenantId],
    );
    await admin.query(
      `update public.connector_sync_state
       set next_poll_at = '2000-01-01T00:00:00Z', next_retry_at = null,
           lease_token = null, lease_expires_at = null
       where connector_id = $1 and tenant_id = $2`,
      [created.connectorId, fixture.tenantId],
    );
    await expect(claimDueSharePointSyncs(1)).resolves.toEqual([]);

    await admin.query(
      `update public.tenants set status = 'active' where id = $1`,
      [fixture.tenantId],
    );
  });
});
