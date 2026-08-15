import { withUserContext } from "@hized/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import {
  createManualFilePipeline,
  getManualFilePipeline,
  persistManualFileRun,
} from "../connectors/connectors";
import { savePipelineBuilderConfiguration } from "../connectors/pipeline-configuration";
import {
  deriveDatasetFieldsFromPipeline,
  listGovernedDatasetGovernance,
  listPipelinePublicationCandidates,
  publishGovernedDatasetFromPipeline,
  saveRecordProjectionRule,
  toGovernedFieldKey,
  updateGovernedFieldGovernance,
} from "./governed-datasets";
import { loadKpiValueRecordDrill, projectDatasetRecords } from "./record-projection";

const HEADERS = ["Job ID", "Team Code", "Completed On", "Job Value", "Engineer Email"];

function jobRows(valueOffset: number) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    { "Job ID": "J-1", "Team Code": "NORTH", "Completed On": today, "Job Value": 100 + valueOffset, "Engineer Email": "engineer.one@example.com" },
    { "Job ID": "J-2", "Team Code": "north", "Completed On": today, "Job Value": 250 + valueOffset, "Engineer Email": "engineer.two@example.com" },
    { "Job ID": "J-3", "Team Code": "UNKNOWN", "Completed On": today, "Job Value": 999, "Engineer Email": "engineer.three@example.com" },
  ];
}

describe("governed record projection and Pulse drill-through", () => {
  const admin = getAdminPool();
  let fixture: TenantFixture;
  let otherTeamManager: { profileId: string; authUserId: string };
  let companyNodeId: string;
  let northNodeId: string;
  let southNodeId: string;
  let pipelineId: string;
  let datasetId: string;
  let kpiValueId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    fixture = await createTenantWithUser(admin, {
      slug: `records-${stamp}`,
      name: "Record Drill Tenant",
      email: `records-${stamp}@test.local`,
    });

    const { rows: [company] } = await admin.query<{ id: string }>(
      `insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'company', 'HQ') returning id`,
      [fixture.tenantId],
    );
    companyNodeId = company.id;
    await admin.query(
      `insert into public.org_node_versions (org_node_id, tenant_id, name, path, valid_from)
       values ($1, $2, 'Record Drill Company', $3::ltree, current_date - 30)`,
      [companyNodeId, fixture.tenantId, companyNodeId.replaceAll("-", "_")],
    );
    for (const [code, name] of [["NORTH", "North team"], ["SOUTH", "South team"]] as const) {
      const { rows: [node] } = await admin.query<{ id: string }>(
        `insert into public.org_nodes (tenant_id, node_type, code) values ($1, 'team', $2) returning id`,
        [fixture.tenantId, code],
      );
      await admin.query(
        `insert into public.org_node_versions (org_node_id, tenant_id, parent_id, name, path, valid_from)
         values ($1, $2, $3, $4, $5::ltree, current_date - 30)`,
        [node.id, fixture.tenantId, companyNodeId, name,
          `${companyNodeId.replaceAll("-", "_")}.${node.id.replaceAll("-", "_")}`],
      );
      if (code === "NORTH") northNodeId = node.id;
      else southNodeId = node.id;
    }

    const { rows: [authUser] } = await admin.query<{ id: string }>(
      `insert into public."user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'South Manager', $1, true) returning id`,
      [`records-south-${stamp}@test.local`],
    );
    const { rows: [profile] } = await admin.query<{ id: string }>(
      `insert into public.profiles (auth_user_id, full_name) values ($1, 'South Manager') returning id`,
      [authUser.id],
    );
    const { rows: [membership] } = await admin.query<{ id: string }>(
      `insert into public.tenant_memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'manager', 'active') returning id`,
      [fixture.tenantId, profile.id],
    );
    await admin.query(
      `insert into public.membership_scopes (membership_id, org_node_id, is_primary) values ($1, $2, true)`,
      [membership.id, southNodeId],
    );
    otherTeamManager = { profileId: profile.id, authUserId: authUser.id };

    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const created = await createManualFilePipeline(client, {
        tenantId: fixture.tenantId,
        createdBy: fixture.profileId,
        name: "Completed jobs",
        loadMode: "upsert",
        keyColumns: ["Job ID"],
      });
      pipelineId = created.pipelineId;
      const pipeline = await getManualFilePipeline(client, { tenantId: fixture.tenantId, pipelineId });
      // First run establishes the observed headers the builder validates against.
      await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline,
        fileName: "jobs.csv",
        contentType: "text/csv",
        contentSha256: "a".repeat(64),
        sizeBytes: 400,
        storageKey: `${fixture.tenantId}/connect/records/jobs-1.csv`,
        sourceModifiedAt: new Date().toISOString(),
        table: { sourceName: "jobs.csv", sheetName: null, headers: HEADERS, rows: jobRows(0) },
      });
      await savePipelineBuilderConfiguration(client, {
        tenantId: fixture.tenantId,
        pipelineId,
        actorUserId: fixture.profileId,
        name: "Completed jobs",
        loadMode: "upsert",
        keyColumns: ["Job ID"],
        pollIntervalMinutes: null,
        changeNote: "Governed field contract",
        fieldMappings: [
          { sourceField: "Job ID", targetField: "Job ID", dataType: "string", isIncluded: true, isRequired: true, position: 0 },
          { sourceField: "Team Code", targetField: "Team Code", dataType: "string", isIncluded: true, isRequired: true, position: 1 },
          { sourceField: "Completed On", targetField: "Completed On", dataType: "date", isIncluded: true, isRequired: true, position: 2 },
          { sourceField: "Job Value", targetField: "Job Value", dataType: "numeric", isIncluded: true, isRequired: false, position: 3 },
          { sourceField: "Engineer Email", targetField: "Engineer Email", dataType: "string", isIncluded: true, isRequired: false, position: 4 },
        ],
      });
      // Second run reloads the same jobs through the typed contract.
      const typedPipeline = await getManualFilePipeline(client, { tenantId: fixture.tenantId, pipelineId });
      const reload = await persistManualFileRun(client, {
        tenantId: fixture.tenantId,
        actorUserId: fixture.profileId,
        pipeline: typedPipeline,
        fileName: "jobs.csv",
        contentType: "text/csv",
        contentSha256: "b".repeat(64),
        sizeBytes: 402,
        storageKey: `${fixture.tenantId}/connect/records/jobs-2.csv`,
        sourceModifiedAt: new Date().toISOString(),
        table: { sourceName: "jobs.csv", sheetName: null, headers: HEADERS, rows: jobRows(0) },
      });
      expect(reload.status).toBe("succeeded");
    });
  });

  afterAll(async () => {
    // audit_log is deliberately immutable to the app role and blocks tenant
    // deletion; only the owner connection used for fixtures can clear it.
    await admin.query("delete from public.audit_log where tenant_id = $1", [fixture.tenantId]);
    await admin.query("delete from public.profiles where id = $1", [otherTeamManager.profileId]);
    await admin.query(`delete from "user" where id = $1`, [otherTeamManager.authUserId]);
    await cleanupFixture(admin, fixture);
    await admin.end();
  });

  it("publishes a governed dataset from the pipeline and defaults personal fields to sensitive", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const candidates = await listPipelinePublicationCandidates(client, { tenantId: fixture.tenantId });
      const candidate = candidates.find((entry) => entry.id === pipelineId)!;
      expect(candidate.curatedRecordCount).toBe(3);
      expect(candidate.publishedDatasetId).toBeNull();

      const fields = deriveDatasetFieldsFromPipeline(candidate.fieldMappings, candidate.keyColumns);
      expect(fields.map((field) => field.fieldKey))
        .toEqual(["job_id", "team_code", "completed_on", "job_value", "engineer_email"]);
      expect(fields.find((field) => field.fieldKey === "engineer_email")?.isSensitive).toBe(true);
      expect(fields.find((field) => field.fieldKey === "job_value")).toMatchObject({
        dataType: "decimal",
        fieldRole: "measure",
        isSensitive: false,
      });
      expect(fields.find((field) => field.fieldKey === "job_id")?.fieldRole).toBe("identifier");

      const published = await publishGovernedDatasetFromPipeline(client, {
        tenantId: fixture.tenantId,
        pipelineId,
        datasetKey: toGovernedFieldKey("Completed jobs"),
        name: "Completed jobs",
        description: "Field service jobs marked complete.",
        subjectArea: "Service delivery",
        refreshCadence: "daily",
        expectedLatencyHours: 24,
        fields,
        actorUserId: fixture.profileId,
      });
      datasetId = published.datasetId;
      expect(published.fieldCount).toBe(5);

      await expect(publishGovernedDatasetFromPipeline(client, {
        tenantId: fixture.tenantId,
        pipelineId,
        datasetKey: "completed_jobs_again",
        name: "Duplicate",
        description: "",
        subjectArea: "Service delivery",
        refreshCadence: "daily",
        expectedLatencyHours: 24,
        fields,
        actorUserId: fixture.profileId,
      })).rejects.toThrow(/already publishes/i);
    });

    const { rows: [kpi] } = await admin.query<{ id: string }>(
      `insert into public.kpi_definitions
         (tenant_id, dataset_id, kpi_key, version_number, name, definition,
          formula_reference, owner_name, reviewer_name, unit, currency_code,
          favourable_direction, aggregation, refresh_cadence, valid_from,
          approval_status, approved_by, approved_at, created_by)
       values ($1, $2, 'completed_job_value', 1, 'Completed job value',
               'Value of jobs completed in the period.', 'sum(job_value)',
               'Operations Director', 'Managing Director', 'currency', 'GBP',
               'higher', 'sum', 'daily', current_date - 30, 'approved', $3, now(), $3)
       returning id`,
      [fixture.tenantId, datasetId, fixture.profileId],
    );
    const { rows: [value] } = await admin.query<{ id: string }>(
      `insert into public.kpi_values
         (tenant_id, kpi_definition_id, org_node_id, period_start, period_end,
          actual_value, target_value, source_refreshed_at, calculated_by)
       values ($1, $2, $3, current_date - 7, current_date + 1, 350, 400, now(), $4)
       returning id`,
      [fixture.tenantId, kpi.id, northNodeId, fixture.profileId],
    );
    kpiValueId = value.id;
  });

  it("refuses to project a sensitive field", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      await expect(saveRecordProjectionRule(client, {
        tenantId: fixture.tenantId,
        datasetId,
        status: "active",
        orgCodeFieldKey: "team_code",
        occurredAtFieldKey: "completed_on",
        measureFieldKey: null,
        projectedFieldKeys: ["job_id", "engineer_email"],
        maxRecords: 5000,
        actorUserId: fixture.profileId,
      })).rejects.toThrow(/engineer_email/);
    });
  });

  it("refuses a contribution field that is not itself projected", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      await expect(saveRecordProjectionRule(client, {
        tenantId: fixture.tenantId,
        datasetId,
        status: "active",
        orgCodeFieldKey: "team_code",
        occurredAtFieldKey: "completed_on",
        measureFieldKey: "job_value",
        projectedFieldKeys: ["job_id", "team_code"],
        maxRecords: 5000,
        actorUserId: fixture.profileId,
      })).rejects.toThrow(/contribution field/i);
    });
  });

  it("projects only records that resolve to an organisation node", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      await saveRecordProjectionRule(client, {
        tenantId: fixture.tenantId,
        datasetId,
        status: "active",
        orgCodeFieldKey: "team_code",
        occurredAtFieldKey: "completed_on",
        measureFieldKey: "job_value",
        projectedFieldKeys: ["job_id", "team_code", "completed_on", "job_value"],
        maxRecords: 5000,
        actorUserId: fixture.profileId,
      });
      const result = await projectDatasetRecords(client, {
        tenantId: fixture.tenantId,
        datasetId,
        actorUserId: fixture.profileId,
      });
      expect(result).toMatchObject({
        projectedRecords: 2,
        unmatchedRecords: 1,
        linkedKpiValues: 1,
        lineageLinks: 2,
      });
      expect(result.skippedReasons).toEqual({ no_matching_organisation: 1 });

      const { rows } = await client.query(
        `select display_data from public.governed_record_projections
          where tenant_id = $1 and dataset_id = $2 order by display_data ->> 'job_id'`,
        [fixture.tenantId, datasetId],
      );
      expect(rows).toHaveLength(2);
      expect(Object.keys(rows[0].display_data).sort())
        .toEqual(["completed_on", "job_id", "job_value", "team_code"]);
      expect(rows[0].display_data.engineer_email).toBeUndefined();

      // Re-running is idempotent rather than cumulative.
      const rerun = await projectDatasetRecords(client, {
        tenantId: fixture.tenantId,
        datasetId,
        actorUserId: fixture.profileId,
      });
      expect(rerun.projectedRecords).toBe(2);
      const { rows: [count] } = await client.query(
        `select count(*)::integer as total from public.governed_record_projections
          where tenant_id = $1 and dataset_id = $2`,
        [fixture.tenantId, datasetId],
      );
      expect(count.total).toBe(2);
    });
  });

  it("returns the contributing records to a permitted viewer and audits the read", async () => {
    const before = await admin.query<{ total: number }>(
      `select count(*)::integer as total from public.audit_log
        where tenant_id = $1 and action = 'pulse.record_drill_through'`,
      [fixture.tenantId],
    );

    const drill = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => loadKpiValueRecordDrill(client, {
        tenantId: fixture.tenantId,
        valueId: kpiValueId,
        actorUserId: fixture.profileId,
      }),
    );
    expect(drill).not.toBeNull();
    expect(drill!.value.kpiName).toBe("Completed job value");
    expect(drill!.records).toHaveLength(2);
    expect(drill!.coverage).toMatchObject({
      linkedRecords: 2,
      returnedRecords: 2,
      contributionTotal: 350,
      explainsAggregate: true,
    });
    expect(drill!.fields.map((field) => field.key))
      .toEqual(["completed_on", "job_id", "job_value", "team_code"]);
    for (const record of drill!.records) {
      expect(record.values).not.toHaveProperty("engineer_email");
    }

    const after = await admin.query<{ total: number; metadata: Record<string, unknown> }>(
      `select count(*)::integer as total,
              (array_agg(metadata order by created_at desc))[1] as metadata
         from public.audit_log
        where tenant_id = $1 and action = 'pulse.record_drill_through'`,
      [fixture.tenantId],
    );
    expect(after.rows[0].total).toBe(before.rows[0].total + 1);
    expect(after.rows[0].metadata).toMatchObject({ linked_records: 2, returned_records: 2 });
  });

  it("denies the drill-through to a manager scoped to another team", async () => {
    const drill = await withUserContext(
      { userId: otherTeamManager.profileId, tenantId: fixture.tenantId },
      (client) => loadKpiValueRecordDrill(client, {
        tenantId: fixture.tenantId,
        valueId: kpiValueId,
        actorUserId: otherTeamManager.profileId,
      }),
    );
    expect(drill).toBeNull();

    const visible = await withUserContext(
      { userId: otherTeamManager.profileId, tenantId: fixture.tenantId },
      (client) => client.query(
        `select count(*)::integer as total from public.governed_record_projections where tenant_id = $1`,
        [fixture.tenantId],
      ),
    );
    expect(visible.rows[0].total).toBe(0);
  });

  it("withdraws published projections when a field becomes sensitive", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      const result = await updateGovernedFieldGovernance(client, {
        tenantId: fixture.tenantId,
        datasetId,
        fields: [{ fieldKey: "job_value", fieldRole: "measure", isSensitive: true }],
        actorUserId: fixture.profileId,
      });
      expect(result.withdrawnFields).toEqual(["job_value"]);

      const { rows: [count] } = await client.query(
        `select count(*)::integer as total from public.governed_record_projections
          where tenant_id = $1 and dataset_id = $2`,
        [fixture.tenantId, datasetId],
      );
      expect(count.total).toBe(0);

      const [dataset] = await listGovernedDatasetGovernance(client, { tenantId: fixture.tenantId });
      // The contribution field was withdrawn, so the rule can no longer stand.
      expect(dataset.projectionRule).toBeNull();
      expect(dataset.fields.find((field) => field.fieldKey === "job_value")?.isSensitive).toBe(true);
    });

    const drill = await withUserContext(
      { userId: fixture.profileId, tenantId: fixture.tenantId },
      (client) => loadKpiValueRecordDrill(client, {
        tenantId: fixture.tenantId,
        valueId: kpiValueId,
        actorUserId: fixture.profileId,
      }),
    );
    expect(drill!.records).toHaveLength(0);
    expect(drill!.coverage.linkedRecords).toBe(0);
  });
});
