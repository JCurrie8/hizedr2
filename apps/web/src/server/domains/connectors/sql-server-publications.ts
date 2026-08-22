import type { PoolClient } from "@neondatabase/serverless";

export interface PipelineSqlPublicationOverview {
  id: string;
  transformationId: string;
  transformationVersion: number;
  pipelineId: string;
  pipelineName: string;
  connectorName: string;
  objectSchema: string;
  objectName: string;
  status: string;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: number;
  nextSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  lastRowsAccepted: number | null;
  publishedDatasetId: string | null;
}

export async function createSqlPublication(
  client: PoolClient,
  input: {
    tenantId: string;
    transformationId: string;
    pipelineId: string;
    createdBy: string;
    scheduleIntervalMinutes: number | null;
  },
): Promise<{ publicationId: string }> {
  if (input.scheduleIntervalMinutes !== null && ![60, 180, 360, 720, 1440].includes(input.scheduleIntervalMinutes)) {
    throw new Error("Choose a supported Hized publication schedule.");
  }
  const { rows: [row] } = await client.query(
    `insert into public.pipeline_sql_publications
       (tenant_id, transformation_id, pipeline_id, created_by,
        schedule_enabled, schedule_interval_minutes, next_sync_at)
     values ($1, $2, $3, $4, $5::integer is not null, coalesce($5::integer, 60),
             case when $5::integer is not null then now() + make_interval(mins => $5::integer) else null end)
     returning id`,
    [input.tenantId, input.transformationId, input.pipelineId, input.createdBy, input.scheduleIntervalMinutes],
  );
  return { publicationId: row.id };
}

export async function listSqlPublicationsForWorkbenchPipeline(
  client: PoolClient,
  input: { tenantId: string; workbenchPipelineId: string },
): Promise<PipelineSqlPublicationOverview[]> {
  const { rows } = await client.query(
    `select publication.id, publication.transformation_id, transformation.version_number,
            publication.pipeline_id, pipeline.name as pipeline_name, connector.name as connector_name,
            transformation.object_schema, transformation.object_name, publication.status,
            publication.schedule_enabled, publication.schedule_interval_minutes,
            publication.next_sync_at, publication.last_success_at, publication.last_error,
            publication.consecutive_failures,
            latest.status as last_run_status, latest.finished_at as last_run_at,
            latest.rows_accepted as last_rows_accepted,
            dataset.id as published_dataset_id
       from public.pipeline_sql_publications publication
       join public.pipeline_sql_transformation_versions transformation
         on transformation.id = publication.transformation_id
        and transformation.tenant_id = publication.tenant_id
       join public.pipeline_sql_destinations destination
         on destination.id = transformation.destination_id
        and destination.tenant_id = transformation.tenant_id
       join public.pipelines pipeline
         on pipeline.id = publication.pipeline_id and pipeline.tenant_id = publication.tenant_id
       join public.connectors connector
         on connector.id = pipeline.connector_id and connector.tenant_id = pipeline.tenant_id
       left join public.governed_datasets dataset
         on dataset.source_pipeline_id = pipeline.id and dataset.tenant_id = pipeline.tenant_id
       left join lateral (
         select run.status, run.finished_at, run.rows_accepted
           from public.pipeline_runs run
          where run.pipeline_id = pipeline.id and run.tenant_id = pipeline.tenant_id
          order by run.started_at desc limit 1
       ) latest on true
      where publication.tenant_id = $1 and destination.pipeline_id = $2
      order by transformation.version_number desc`,
    [input.tenantId, input.workbenchPipelineId],
  );
  return rows.map((row) => ({
    id: row.id,
    transformationId: row.transformation_id,
    transformationVersion: Number(row.version_number),
    pipelineId: row.pipeline_id,
    pipelineName: row.pipeline_name,
    connectorName: row.connector_name,
    objectSchema: row.object_schema,
    objectName: row.object_name,
    status: row.status,
    scheduleEnabled: row.schedule_enabled,
    scheduleIntervalMinutes: Number(row.schedule_interval_minutes),
    nextSyncAt: row.next_sync_at ? new Date(row.next_sync_at).toISOString() : null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    lastError: row.last_error,
    consecutiveFailures: Number(row.consecutive_failures),
    lastRunStatus: row.last_run_status,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastRowsAccepted: row.last_rows_accepted === null ? null : Number(row.last_rows_accepted),
    publishedDatasetId: row.published_dataset_id ?? null,
  }));
}

export async function acquireSqlPublicationLease(
  client: PoolClient,
  input: { tenantId: string; publicationId: string },
): Promise<{ pipelineId: string; leaseToken: string }> {
  const { rows: [row] } = await client.query(
    `update public.pipeline_sql_publications set
       lease_token = gen_random_uuid(), lease_expires_at = now() + interval '15 minutes',
       last_attempt_at = now(), updated_at = now()
     where id = $1 and tenant_id = $2 and status = 'active'
       and (lease_expires_at is null or lease_expires_at <= now())
       and exists (
         select 1 from public.pipeline_sql_transformation_versions transformation
          where transformation.id = pipeline_sql_publications.transformation_id
            and transformation.tenant_id = pipeline_sql_publications.tenant_id
            and transformation.status = 'approved'
       )
     returning pipeline_id, lease_token`,
    [input.publicationId, input.tenantId],
  );
  if (!row) throw new Error("This approved SQL publication is already running or inactive.");
  return { pipelineId: row.pipeline_id, leaseToken: row.lease_token };
}

export async function completeSqlPublication(
  client: PoolClient,
  input: { tenantId: string; publicationId: string; leaseToken: string | null },
): Promise<void> {
  const result = await client.query(
    `update public.pipeline_sql_publications set
       last_success_at = now(), last_error = null, consecutive_failures = 0,
       next_retry_at = null, lease_token = null, lease_expires_at = null,
       next_sync_at = case when schedule_enabled
         then now() + make_interval(mins => schedule_interval_minutes) else null end,
       updated_at = now()
     where id = $1 and tenant_id = $2 and lease_token is not distinct from $3::uuid`,
    [input.publicationId, input.tenantId, input.leaseToken],
  );
  if (result.rowCount !== 1) throw new Error("The SQL publication lease changed before completion.");
}

export async function failSqlPublication(
  client: PoolClient,
  input: { tenantId: string; publicationId: string; leaseToken: string; message: string },
): Promise<void> {
  await client.query(
    `update public.pipeline_sql_publications set
       last_error = $4, consecutive_failures = consecutive_failures + 1,
       next_retry_at = now() + make_interval(mins => least(360, (15 * power(2, least(consecutive_failures, 4)))::integer)),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where id = $1 and tenant_id = $2 and lease_token = $3`,
    [input.publicationId, input.tenantId, input.leaseToken, input.message.slice(0, 500)],
  );
}
