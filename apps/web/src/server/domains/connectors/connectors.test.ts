import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  createManualFilePipeline,
  getManualFilePipeline,
  persistManualFileFailure,
  persistManualFileRun,
} from "./connectors";

describe("manual file pipeline persistence", () => {
  const admin = getAdminPool();
  let fixture: TenantFixture;

  beforeAll(async () => {
    fixture = await createTenantWithUser(admin, {
      slug: `connect-test-${Date.now()}`,
      name: "Connect Test",
      email: `connect-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await admin.end();
  });

  it("commits a run, landed rows and curated upserts in one tenant-scoped transaction", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const created = await createManualFilePipeline(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Form responses",
        loadMode: "upsert",
        keyColumns: ["Response ID"],
      });
      const pipeline = await getManualFilePipeline(client, { tenantId: fixture.tenantId, pipelineId: created.pipelineId });
      const result = await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline,
        fileName: "responses.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentSha256: "d".repeat(64),
        sizeBytes: 100,
        storageKey: `${fixture.tenantId}/connect/test/responses.xlsx`,
        sourceModifiedAt: "2026-08-02T12:00:00.000Z",
        table: {
          sourceName: "responses.xlsx",
          sheetName: "Form1",
          headers: ["Response ID", "Score"],
          rows: [{ "Response ID": "a", Score: 7 }, { "Response ID": "b", Score: 8 }],
        },
      });
      expect(result).toMatchObject({ status: "succeeded", duplicate: false, acceptedRows: 2, rejectedRows: 0 });

      const { rows: [counts] } = await client.query(
        `select
           (select count(*)::integer from public.landed_rows where run_id = $1) as landed,
           (select count(*)::integer from public.curated_records where pipeline_id = $2) as curated,
           (select count(*)::integer from public.validation_results where run_id = $1) as validations`,
        [result.runId, pipeline.id],
      );
      expect(counts).toEqual({ landed: 2, curated: 2, validations: 1 });

      const duplicate = await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline,
        fileName: "responses.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentSha256: "d".repeat(64),
        sizeBytes: 100,
        storageKey: `${fixture.tenantId}/connect/test/replay.xlsx`,
        sourceModifiedAt: "2026-08-02T12:05:00.000Z",
        table: {
          sourceName: "responses.xlsx",
          sheetName: "Form1",
          headers: ["Response ID", "Score"],
          rows: [{ "Response ID": "a", Score: 7 }, { "Response ID": "b", Score: 8 }],
        },
      });
      expect(duplicate).toMatchObject({ runId: result.runId, duplicate: true });
    });
  });

  it("records a failed attempt and permits the same immutable batch to be retried", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const created = await createManualFilePipeline(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Retryable responses",
        loadMode: "upsert",
        keyColumns: ["Response ID"],
      });
      const pipeline = await getManualFilePipeline(client, { tenantId: fixture.tenantId, pipelineId: created.pipelineId });
      const source = {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline,
        fileName: "retry.csv",
        contentType: "text/csv",
        contentSha256: "e".repeat(64),
        sizeBytes: 50,
        storageKey: `${fixture.tenantId}/connect/test/retry.csv`,
        sourceModifiedAt: "2026-08-02T13:00:00.000Z",
      };
      const failed = await persistManualFileFailure(client, {
        ...source,
        errorMessage: "The configured key column is missing.",
      });
      const retried = await persistManualFileRun(client, {
        ...source,
        table: {
          sourceName: "retry.csv",
          sheetName: null,
          headers: ["Response ID", "Score"],
          rows: [{ "Response ID": "a", Score: 9 }],
        },
      });

      expect(retried).toMatchObject({ status: "succeeded", duplicate: false, sourceObjectReused: true });
      expect(retried.runId).not.toBe(failed.runId);
      const { rows } = await client.query(
        `select status from public.pipeline_runs
         where pipeline_id = $1 and source_batch_id = (
           select source_batch_id from public.pipeline_runs where id = $2
         )
         order by id`,
        [pipeline.id, failed.runId],
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["failed", "succeeded"]));
    });
  });
});
