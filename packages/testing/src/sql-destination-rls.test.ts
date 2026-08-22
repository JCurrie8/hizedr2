import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "./fixtures";

describe("SQL workbench destination RLS", () => {
  const admin = getAdminPool();
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let employee: TenantFixture;
  let destinationA: string;
  let destinationB: string;
  let runA: string;
  let runB: string;
  let sourceA: string;
  let sourceB: string;
  let pipelineA: string;
  let pipelineB: string;
  let transformationA: string;
  let transformationB: string;

  beforeAll(async () => {
    tenantA = await createTenantWithUser(admin, {
      slug: `sql-dest-rls-a-${Date.now()}`,
      name: "SQL Destination RLS A",
      email: `sql-dest-rls-a-${Date.now()}@test.local`,
    });
    tenantB = await createTenantWithUser(admin, {
      slug: `sql-dest-rls-b-${Date.now()}`,
      name: "SQL Destination RLS B",
      email: `sql-dest-rls-b-${Date.now()}@test.local`,
    });
    employee = await createTenantWithUser(admin, {
      slug: `sql-dest-rls-employee-${Date.now()}`,
      name: "SQL Destination RLS Employee",
      email: `sql-dest-rls-employee-${Date.now()}@test.local`,
      role: "employee",
    });

    for (const [fixture, suffix] of [[tenantA, "a"], [tenantB, "b"]] as const) {
      const { rows: [source] } = await admin.query(
        `insert into public.connectors (tenant_id, connector_type, name, status, created_by)
         values ($1, 'file_upload', $2, 'active', $3) returning id`,
        [fixture.tenantId, `File source ${suffix}`, fixture.profileId],
      );
      const { rows: [loader] } = await admin.query(
        `insert into public.connectors (tenant_id, connector_type, name, status, auth_mode, config, created_by)
         values ($1, 'sql_server', $2, 'active', 'connection_string',
                 jsonb_build_object('direction', 'destination', 'managedSchema', 'hized_landing'), $3)
         returning id`,
        [fixture.tenantId, `SQL loader ${suffix}`, fixture.profileId],
      );
      const { rows: [pipeline] } = await admin.query(
        `insert into public.pipelines (tenant_id, connector_id, name, status, created_by)
         values ($1, $2, $3, 'active', $4) returning id`,
        [fixture.tenantId, source.id, `Pipeline ${suffix}`, fixture.profileId],
      );
      await admin.query(
        `insert into public.connector_credentials
           (tenant_id, connector_id, ciphertext, iv, auth_tag, key_version, created_by)
         values ($1, $2, decode(repeat('00', 32), 'hex'), decode(repeat('00', 12), 'hex'),
                 decode(repeat('00', 16), 'hex'), 1, $3)`,
        [fixture.tenantId, loader.id, fixture.profileId],
      );
      const { rows: [batch] } = await admin.query(
        `insert into public.source_batches
           (tenant_id, connector_id, batch_kind, source_item_id, source_name,
            content_sha256, content_type, size_bytes, storage_key)
         values ($1, $2, 'file_revision', $3, $3, $4, 'text/csv', 10, $5)
         returning id`,
        [fixture.tenantId, source.id, `source-${suffix}.csv`, suffix.repeat(64), `${fixture.tenantId}/source-${suffix}.csv`],
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
           (tenant_id, pipeline_id, connector_id, target_schema, target_table, created_by,
            schedule_enabled, schedule_interval_minutes, next_load_at)
         values ($1, $2, $3, 'hized_landing', $4, $5, true, 60, now()) returning id`,
        [fixture.tenantId, pipeline.id, loader.id, `target_${suffix}`, fixture.profileId],
      );
      const { rows: [destinationRun] } = await admin.query(
        `insert into public.pipeline_sql_destination_runs
           (tenant_id, destination_id, source_run_id, status, rows_written, finished_at)
         values ($1, $2, $3, 'succeeded', 1, now()) returning id`,
        [fixture.tenantId, destination.id, sourceRun.id],
      );
      const { rows: [transformation] } = await admin.query(
        `insert into public.pipeline_sql_transformation_versions
           (tenant_id, destination_id, version_number, object_schema, object_name,
            object_type, column_signature, status, change_note, validated_at,
            created_by, approved_by, approved_at)
         values ($1, $2, 1, 'hized_landing', $3, 'view',
                 '[{"name":"record_id","sqlType":"uniqueidentifier","dataType":"string","nullable":false,"primaryKey":true}]',
                 'approved', 'RLS fixture', now(), $4, $4, now()) returning id`,
        [fixture.tenantId, destination.id, `ready_${suffix}`, fixture.profileId],
      );
      if (fixture === tenantA) {
        destinationA = destination.id;
        runA = destinationRun.id;
        sourceA = source.id;
        pipelineA = pipeline.id;
        transformationA = transformation.id;
      } else {
        destinationB = destination.id;
        runB = destinationRun.id;
        sourceB = source.id;
        pipelineB = pipeline.id;
        transformationB = transformation.id;
      }
    }
  });

  afterAll(async () => {
    await cleanupFixture(admin, tenantA);
    await cleanupFixture(admin, tenantB);
    await cleanupFixture(admin, employee);
    await admin.end();
  });

  it("keeps destination configuration and load history inside the explicitly selected tenant", async () => {
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role, status) values ($1, $2, 'company_admin', 'active')",
      [tenantB.tenantId, tenantA.profileId],
    );
    try {
      const scopedA = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantA.tenantId },
        async (client) => ({
          destinations: await client.query("select id from public.pipeline_sql_destinations").then((result) => result.rows),
          runs: await client.query("select id from public.pipeline_sql_destination_runs").then((result) => result.rows),
          transformations: await client.query("select id from public.pipeline_sql_transformation_versions").then((result) => result.rows),
        }),
      );
      expect(scopedA).toEqual({
        destinations: [{ id: destinationA }],
        runs: [{ id: runA }],
        transformations: [{ id: transformationA }],
      });

      const scopedB = await withUserContext(
        { userId: tenantA.profileId, tenantId: tenantB.tenantId },
        async (client) => ({
          destinations: await client.query("select id from public.pipeline_sql_destinations").then((result) => result.rows),
          runs: await client.query("select id from public.pipeline_sql_destination_runs").then((result) => result.rows),
          transformations: await client.query("select id from public.pipeline_sql_transformation_versions").then((result) => result.rows),
        }),
      );
      expect(scopedB).toEqual({
        destinations: [{ id: destinationB }],
        runs: [{ id: runB }],
        transformations: [{ id: transformationB }],
      });
    } finally {
      await admin.query("delete from public.tenant_memberships where tenant_id = $1 and user_id = $2", [tenantB.tenantId, tenantA.profileId]);
    }
  });

  it("keeps SQL destination stages invisible and unwritable to an ordinary employee", async () => {
    const rows = await withUserContext(
      { userId: employee.profileId, tenantId: employee.tenantId },
      async (client) => ({
        destinations: await client.query("select id from public.pipeline_sql_destinations").then((result) => result.rows),
        runs: await client.query("select id from public.pipeline_sql_destination_runs").then((result) => result.rows),
        transformations: await client.query("select id from public.pipeline_sql_transformation_versions").then((result) => result.rows),
      }),
    );
    expect(rows).toEqual({ destinations: [], runs: [], transformations: [] });

    await expect(withUserContext(
      { userId: employee.profileId, tenantId: employee.tenantId },
      (client) => client.query(
        `insert into public.pipeline_sql_destinations
           (tenant_id, pipeline_id, connector_id, target_schema, target_table, created_by)
         values ($1, gen_random_uuid(), gen_random_uuid(), 'hized_landing', 'blocked', $2)`,
        [employee.tenantId, employee.profileId],
      ),
    )).rejects.toThrow();
    await expect(withUserContext(
      { userId: employee.profileId, tenantId: employee.tenantId },
      (client) => client.query(
        `insert into public.pipeline_sql_transformation_versions
           (tenant_id, destination_id, version_number, object_schema, object_name,
            object_type, column_signature, change_note, validated_at, created_by)
         values ($1, gen_random_uuid(), 1, 'hized_landing', 'blocked', 'view', '[]',
                 'blocked', now(), $2)`,
        [employee.tenantId, employee.profileId],
      ),
    )).rejects.toThrow();
  });

  it("claims due cross-tenant work without returning a locked tenant", async () => {
    for (const [fixture, sourceId, pipelineId, suffix] of [
      [tenantA, sourceA, pipelineA, "eligible"],
      [tenantB, sourceB, pipelineB, "locked"],
    ] as const) {
      const { rows: [batch] } = await admin.query(
        `insert into public.source_batches
           (tenant_id, connector_id, batch_kind, source_item_id, source_name,
            content_sha256, content_type, size_bytes, storage_key)
         values ($1, $2, 'file_revision', $3, $3, $4, 'text/csv', 10, $5)
         returning id`,
        [fixture.tenantId, sourceId, `${suffix}.csv`, (suffix === "eligible" ? "e" : "b").repeat(64), `${fixture.tenantId}/${suffix}.csv`],
      );
      await admin.query(
        `insert into public.pipeline_runs
           (tenant_id, pipeline_id, connector_id, source_batch_id, trigger_type,
            status, initiated_by, started_at, finished_at, rows_received, rows_accepted)
         values ($1, $2, $3, $4, 'manual_upload', 'succeeded', $5, now(), now(), 1, 1)`,
        [fixture.tenantId, pipelineId, sourceId, batch.id, fixture.profileId],
      );
    }
    await admin.query(
      `update public.tenant_product_entitlements
          set status = 'locked'
        where tenant_id = $1 and product_key = 'connect'`,
      [tenantB.tenantId],
    );

    const { rows } = await withUserContext(
      { userId: tenantA.profileId, tenantId: tenantA.tenantId },
      (client) => client.query("select * from public.claim_due_sql_destination_syncs(20)"),
    );
    expect(rows.some((row) => row.destination_id === destinationA)).toBe(true);
    expect(rows.some((row) => row.destination_id === destinationB)).toBe(false);
  });
});
