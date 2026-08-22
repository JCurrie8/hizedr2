import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  approveSqlTransformationVersion,
  listPipelineSqlTransformationVersions,
  registerSqlTransformationVersion,
} from "./sql-server-transformations";
import { createSqlServerPipeline } from "./sql-server-connectors";
import { acquireSqlPublicationLease, createSqlPublication, listSqlPublicationsForWorkbenchPipeline } from "./sql-server-publications";
import { claimDueSqlPublicationSyncs } from "./sql-server-publication-scheduler";

describe("SQL transformation approval persistence", () => {
  const admin = getAdminPool();
  let fixture: TenantFixture;
  let other: TenantFixture;
  let pipelineId: string;
  let destinationId: string;
  let publisherConnectorId: string;
  let approvedTransformationId: string;
  let approvedPublicationId: string;

  beforeAll(async () => {
    fixture = await createTenantWithUser(admin, {
      slug: `sql-transform-${Date.now()}`,
      name: "SQL Transformation Test",
      email: `sql-transform-${Date.now()}@test.local`,
    });
    other = await createTenantWithUser(admin, {
      slug: `sql-transform-other-${Date.now()}`,
      name: "SQL Transformation Other",
      email: `sql-transform-other-${Date.now()}@test.local`,
    });
    const { rows: [source] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, status, created_by)
       values ($1, 'file_upload', 'Transformation source', 'active', $2) returning id`,
      [fixture.tenantId, fixture.profileId],
    );
    const { rows: [loader] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, status, auth_mode, config, created_by)
       values ($1, 'sql_server', 'Transformation loader', 'active', 'connection_string',
               jsonb_build_object('direction', 'destination', 'managedSchema', 'hized_landing',
                                  'server', 'sql.activ8.example', 'port', 1433, 'database', 'HizedWorkbench'), $2)
       returning id`,
      [fixture.tenantId, fixture.profileId],
    );
    const { rows: [publisher] } = await admin.query(
      `insert into public.connectors (tenant_id, connector_type, name, status, auth_mode, config, created_by)
       values ($1, 'sql_server', 'Read-only publisher', 'active', 'connection_string',
               jsonb_build_object('direction', 'source', 'server', 'sql.activ8.example',
                                  'port', 1433, 'database', 'HizedWorkbench'), $2) returning id`,
      [fixture.tenantId, fixture.profileId],
    );
    publisherConnectorId = publisher.id;
    await admin.query(
      `insert into public.connector_credentials
         (tenant_id, connector_id, ciphertext, iv, auth_tag, key_version, created_by)
       values ($1, $2, decode(repeat('00', 32), 'hex'), decode(repeat('00', 12), 'hex'),
               decode(repeat('00', 16), 'hex'), 1, $3)`,
      [fixture.tenantId, publisher.id, fixture.profileId],
    );
    const { rows: [pipeline] } = await admin.query(
      `insert into public.pipelines (tenant_id, connector_id, name, status, created_by)
       values ($1, $2, 'Transformation pipeline', 'active', $3) returning id`,
      [fixture.tenantId, source.id, fixture.profileId],
    );
    pipelineId = pipeline.id;
    const { rows: [batch] } = await admin.query(
      `insert into public.source_batches
         (tenant_id, connector_id, batch_kind, source_item_id, source_name,
          content_sha256, content_type, size_bytes, storage_key)
       values ($1, $2, 'file_revision', 'transform.csv', 'transform.csv', $3,
               'text/csv', 10, $4) returning id`,
      [fixture.tenantId, source.id, "d".repeat(64), `${fixture.tenantId}/transform.csv`],
    );
    const { rows: [sourceRun] } = await admin.query(
      `insert into public.pipeline_runs
         (tenant_id, pipeline_id, connector_id, source_batch_id, trigger_type,
          status, initiated_by, started_at, finished_at, rows_received, rows_accepted)
       values ($1, $2, $3, $4, 'manual_upload', 'succeeded', $5, now(), now(), 1, 1)
       returning id`,
      [fixture.tenantId, pipeline.id, source.id, batch.id, fixture.profileId],
    );
    const { rows: [destination] } = await admin.query(
      `insert into public.pipeline_sql_destinations
         (tenant_id, pipeline_id, connector_id, target_schema, target_table, created_by)
       values ($1, $2, $3, 'hized_landing', 'raw_operations', $4) returning id`,
      [fixture.tenantId, pipeline.id, loader.id, fixture.profileId],
    );
    destinationId = destination.id;
    await admin.query(
      `insert into public.pipeline_sql_destination_runs
         (tenant_id, destination_id, source_run_id, status, rows_written, finished_at)
       values ($1, $2, $3, 'succeeded', 1, now())`,
      [fixture.tenantId, destination.id, sourceRun.id],
    );
  });

  afterAll(async () => {
    await cleanupFixture(admin, fixture);
    await cleanupFixture(admin, other);
    await admin.end();
  });

  const description = (name: string) => ({
    schema: "hized_landing",
    name,
    objectType: "view" as const,
    fields: [
      { name: "account_id", sqlType: "uniqueidentifier", dataType: "string" as const, nullable: false, primaryKey: true, supported: true },
      { name: "revenue", sqlType: "decimal", dataType: "numeric" as const, nullable: true, primaryKey: false, supported: true },
    ],
  });

  it("versions, approves and supersedes validated objects without losing approval history", async () => {
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => registerSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        destinationId,
        actorUserId: fixture.profileId,
        description: description("raw_operations"),
        changeNote: "Must not approve raw landing data",
      }),
    )).rejects.toThrow(/landing table/);
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => registerSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        destinationId,
        actorUserId: other.profileId,
        description: description("spoofed_actor"),
        changeNote: "Must remain bound to the session actor",
      }),
    )).rejects.toThrow(/not authorised/);
    const first = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => registerSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        destinationId,
        actorUserId: fixture.profileId,
        description: description("operations_ready_v1"),
        changeNote: "Initial cleaned model",
      }),
    );
    expect(first.versionNumber).toBe(1);
    await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => approveSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        transformationId: first.id,
        actorUserId: fixture.profileId,
      }),
    );
    const second = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => registerSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        destinationId,
        actorUserId: fixture.profileId,
        description: description("operations_ready_v2"),
        changeNote: "Standardised revenue",
      }),
    );
    await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => approveSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        transformationId: second.id,
        actorUserId: fixture.profileId,
      }),
    );
    approvedTransformationId = second.id;
    const versions = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => listPipelineSqlTransformationVersions(client, { tenantId: fixture.tenantId, pipelineId }),
    );
    expect(versions.map(({ versionNumber, status }) => ({ versionNumber, status }))).toEqual([
      { versionNumber: 2, status: "approved" },
      { versionNumber: 1, status: "superseded" },
    ]);
    expect(versions[1].approvedBy).toBe(fixture.profileId);
    expect(versions[1].approvedAt).not.toBeNull();
  });

  it("links only the exact approved signature through a separate read-only pipeline and claims scheduled work", async () => {
    const badPipeline = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => createSqlServerPipeline(client, {
        tenantId: fixture.tenantId,
        connectorId: publisherConnectorId,
        createdBy: fixture.profileId,
        pipelineName: "Unlinked publication",
        description: description("operations_ready_v2"),
        selectedFields: ["account_id", "revenue"],
        keyColumns: [],
        watermarkField: null,
        loadMode: "snapshot",
        overlapSeconds: 0,
      }),
    );
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => createSqlPublication(client, {
        tenantId: fixture.tenantId,
        transformationId: approvedTransformationId,
        pipelineId: badPipeline.pipelineId,
        createdBy: fixture.profileId,
        scheduleIntervalMinutes: 60,
      }),
    )).rejects.toThrow(/does not match/);

    const publication = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      async (client) => {
        const pipeline = await createSqlServerPipeline(client, {
          tenantId: fixture.tenantId,
          connectorId: publisherConnectorId,
          createdBy: fixture.profileId,
          pipelineName: "Approved operations publication",
          description: description("operations_ready_v2"),
          selectedFields: ["account_id", "revenue"],
          keyColumns: [],
          watermarkField: null,
          loadMode: "snapshot",
          overlapSeconds: 0,
          approvedTransformationId,
        });
        const publication = await createSqlPublication(client, {
          tenantId: fixture.tenantId,
          transformationId: approvedTransformationId,
          pipelineId: pipeline.pipelineId,
          createdBy: fixture.profileId,
          scheduleIntervalMinutes: 60,
        });
        return { ...publication, pipelineId: pipeline.pipelineId };
      },
    );
    approvedPublicationId = publication.publicationId;
    const listed = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => listSqlPublicationsForWorkbenchPipeline(client, {
        tenantId: fixture.tenantId,
        workbenchPipelineId: pipelineId,
      }),
    );
    expect(listed).toEqual([expect.objectContaining({
      id: publication.publicationId,
      transformationVersion: 2,
      pipelineName: "Approved operations publication",
      scheduleEnabled: true,
    })]);
    await admin.query("update public.pipeline_sql_publications set next_sync_at = now() where id = $1", [publication.publicationId]);
    const jobs = await claimDueSqlPublicationSyncs(20);
    expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({
      tenantId: fixture.tenantId,
      publicationId: publication.publicationId,
      connectorId: publisherConnectorId,
    })]));
    expect(jobs.some((job) => job.tenantId === other.tenantId)).toBe(false);
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => client.query(
        "update public.pipelines set source_config = source_config || '{\"object\":\"repointed\"}' where id = $1 and tenant_id = $2",
        [publication.pipelineId, fixture.tenantId],
      ),
    )).rejects.toThrow(/cannot be repointed/);
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => client.query(
        "delete from public.pipeline_field_mappings where pipeline_id = $1 and tenant_id = $2",
        [publication.pipelineId, fixture.tenantId],
      ),
    )).rejects.toThrow(/field mappings are immutable/);
    await admin.query(
      "update public.pipeline_sql_publications set lease_token = null, lease_expires_at = null, next_sync_at = now() + interval '1 hour' where id = $1",
      [publication.publicationId],
    );
  });

  it("lets analysts register but never approve, and fails closed across tenants and direct writes", async () => {
    let analystDraftId = "";
    await admin.query(
      `update public.tenant_memberships set role = 'analyst'
        where tenant_id = $1 and user_id = $2`,
      [fixture.tenantId, fixture.profileId],
    );
    try {
      const draft = await withUserContext(
        { userId: fixture.profileId, tenantId: fixture.tenantId },
        (client) => registerSqlTransformationVersion(client, {
          tenantId: fixture.tenantId,
          destinationId,
          actorUserId: fixture.profileId,
          description: description("operations_ready_v3"),
          changeNote: "Analyst-proposed revision",
        }),
      );
      analystDraftId = draft.id;
      await expect(withUserContext(
        { userId: fixture.profileId, tenantId: fixture.tenantId },
        (client) => approveSqlTransformationVersion(client, {
          tenantId: fixture.tenantId,
          transformationId: draft.id,
          actorUserId: fixture.profileId,
        }),
      )).rejects.toThrow(/Company Admin/);
      await expect(withUserContext(
        { userId: fixture.profileId, tenantId: fixture.tenantId },
        (client) => client.query(
          `insert into public.pipeline_sql_transformation_versions
             (tenant_id, destination_id, version_number, object_schema, object_name,
              object_type, column_signature, change_note, validated_at, created_by)
           values ($1, $2, 99, 'hized_landing', 'blocked', 'view', '[]', 'blocked', now(), $3)`,
          [fixture.tenantId, destinationId, fixture.profileId],
        ),
      )).rejects.toThrow();
      await expect(withUserContext(
        { userId: fixture.profileId, tenantId: fixture.tenantId },
        (client) => client.query(
          `select * from public.create_sql_transformation_version(
             $1, $2, 'hized_landing', 'malformed_signature', 'view', '[{}]'::jsonb,
             'Malformed direct call', $3)`,
          [fixture.tenantId, destinationId, fixture.profileId],
        ),
      )).rejects.toThrow(/column signature is invalid/);
    } finally {
      await admin.query(
        `update public.tenant_memberships set role = 'company_admin'
          where tenant_id = $1 and user_id = $2`,
        [fixture.tenantId, fixture.profileId],
      );
    }
    await expect(withUserContext(
      { userId: other.profileId, tenantId: other.tenantId },
      (client) => listPipelineSqlTransformationVersions(client, { tenantId: other.tenantId, pipelineId }),
    )).resolves.toEqual([]);
    await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => approveSqlTransformationVersion(client, {
        tenantId: fixture.tenantId,
        transformationId: analystDraftId,
        actorUserId: fixture.profileId,
      }),
    );
    await expect(withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => acquireSqlPublicationLease(client, {
        tenantId: fixture.tenantId,
        publicationId: approvedPublicationId,
      }),
    )).rejects.toThrow(/already running or inactive/);
  });
});
