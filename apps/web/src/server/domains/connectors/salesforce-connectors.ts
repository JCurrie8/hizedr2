import type { PoolClient } from "@neondatabase/serverless";
import {
  openConnectorValue,
  sealConnectorValue,
  sealedValueFromRow,
} from "./credential-crypto";
import type {
  SalesforceCredentials,
  SalesforceFieldSummary,
  SalesforceObjectDescription,
  SalesforceObjectSummary,
} from "./salesforce-api";
import { listPipelineFieldMappings } from "./pipeline-configuration";
import type { PipelineFieldMapping } from "./tabular-load";

export interface SalesforcePipelineOverview {
  id: string;
  name: string;
  objectName: string;
  pollIntervalMinutes: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  status: string;
}

export interface SalesforceConnectorOverview {
  id: string;
  name: string;
  status: string;
  apiVersion: string;
  myDomainUrl: string;
  catalog: SalesforceObjectSummary[];
  catalogRefreshedAt: string | null;
  pipelines: SalesforcePipelineOverview[];
}

export interface SalesforceSyncContext {
  connectorId: string;
  credentials: SalesforceCredentials;
  apiVersion: string;
  pipeline: {
    id: string;
    connectorId: string;
    name: string;
    loadMode: "upsert";
    keyColumns: ["Id"];
    fieldMappings: PipelineFieldMapping[];
  };
  objectName: string;
  fields: string[];
  modifiedField: string;
  includeDeleted: boolean;
  initialLookbackSeconds: number | null;
  overlapSeconds: number;
  committedThroughAt: string | null;
}

function parseCatalog(value: unknown): SalesforceObjectSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.label !== "string") return [];
    return [{ name: item.name, label: item.label, custom: item.custom === true }];
  });
}

function openSalesforceCredentials(row: Record<string, unknown>, binding: { tenantId: string; connectorId: string }) {
  const credentials = openConnectorValue<SalesforceCredentials>(
    sealedValueFromRow(row),
    "credentials",
    `${binding.tenantId}:${binding.connectorId}`,
  );
  if (!credentials.myDomainUrl || !credentials.clientId || !credentials.clientSecret) {
    throw new Error("The Salesforce credential payload is incomplete.");
  }
  return credentials;
}

export async function createSalesforceConnector(
  client: PoolClient,
  input: {
    tenantId: string;
    createdBy: string;
    name: string;
    credentials: SalesforceCredentials;
    apiVersion: string;
    catalog: SalesforceObjectSummary[];
  },
): Promise<{ connectorId: string }> {
  const config = {
    myDomainUrl: input.credentials.myDomainUrl,
    apiVersion: input.apiVersion,
    catalog: input.catalog,
    catalogRefreshedAt: new Date().toISOString(),
  };
  const { rows: [connector] } = await client.query(
    `insert into public.connectors
       (tenant_id, connector_type, name, status, auth_mode, config, created_by,
        last_tested_at, last_test_status, last_test_message)
     values ($1, 'salesforce', $2, 'active', 'client_credentials', $3::jsonb, $4,
             now(), 'succeeded', 'Salesforce integration user connected')
     returning id`,
    [input.tenantId, input.name, JSON.stringify(config), input.createdBy],
  );
  const sealed = sealConnectorValue(
    input.credentials,
    "credentials",
    `${input.tenantId}:${connector.id}`,
  );
  await client.query(
    `insert into public.connector_credentials
       (tenant_id, connector_id, ciphertext, iv, auth_tag, key_version, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [input.tenantId, connector.id, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, input.createdBy],
  );
  return { connectorId: connector.id };
}

export async function listSalesforceConnectors(
  client: PoolClient,
  input: { tenantId: string },
): Promise<SalesforceConnectorOverview[]> {
  const { rows } = await client.query(
    `select c.id, c.name, c.status, c.config,
            coalesce(jsonb_agg(
              jsonb_build_object(
                'id', p.id,
                'name', p.name,
                'objectName', p.source_config ->> 'object',
                'pollIntervalMinutes', pss.poll_interval_minutes,
                'lastSuccessAt', pss.last_success_at,
                'lastError', pss.last_error,
                'status', p.status
              ) order by p.created_at
            ) filter (where p.id is not null), '[]'::jsonb) as pipelines
     from public.connectors c
     left join public.pipelines p
       on p.connector_id = c.id and p.tenant_id = c.tenant_id and p.status <> 'disabled'
     left join public.pipeline_sync_state pss
       on pss.pipeline_id = p.id and pss.tenant_id = p.tenant_id
     where c.tenant_id = $1 and c.connector_type = 'salesforce' and c.status <> 'disabled'
     group by c.id
     order by c.created_at desc`,
    [input.tenantId],
  );
  return rows.map((row) => {
    const config = row.config as Record<string, unknown>;
    const pipelines = (Array.isArray(row.pipelines) ? row.pipelines : []) as Array<Record<string, unknown>>;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      apiVersion: String(config.apiVersion ?? ""),
      myDomainUrl: String(config.myDomainUrl ?? ""),
      catalog: parseCatalog(config.catalog),
      catalogRefreshedAt: typeof config.catalogRefreshedAt === "string" ? config.catalogRefreshedAt : null,
      pipelines: pipelines.map((pipeline) => ({
        id: String(pipeline.id),
        name: String(pipeline.name),
        objectName: String(pipeline.objectName),
        pollIntervalMinutes: Number(pipeline.pollIntervalMinutes ?? 1440),
        lastSuccessAt: pipeline.lastSuccessAt ? new Date(String(pipeline.lastSuccessAt)).toISOString() : null,
        lastError: typeof pipeline.lastError === "string" ? pipeline.lastError : null,
        status: String(pipeline.status),
      })),
    };
  });
}

export async function getSalesforceConnectorCredentials(
  client: PoolClient,
  input: { tenantId: string; connectorId: string },
): Promise<{ credentials: SalesforceCredentials; apiVersion: string }> {
  const { rows: [row] } = await client.query(
    `select c.config, cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version
     from public.connectors c
     join public.connector_credentials cc
       on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
     where c.id = $1 and c.tenant_id = $2 and c.connector_type = 'salesforce'
       and c.status in ('active', 'error')`,
    [input.connectorId, input.tenantId],
  );
  if (!row) throw new Error("The Salesforce connection was not found or has no credentials.");
  const config = row.config as Record<string, unknown>;
  const apiVersion = String(config.apiVersion ?? "");
  if (!apiVersion) throw new Error("The Salesforce API version is missing from this connection.");
  return {
    credentials: openSalesforceCredentials(row, input),
    apiVersion,
  };
}

export async function replaceSalesforceCatalog(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; apiVersion: string; catalog: SalesforceObjectSummary[] },
): Promise<void> {
  const result = await client.query(
    `update public.connectors set
       config = config || $3::jsonb,
       status = 'active', last_tested_at = now(), last_test_status = 'succeeded',
       last_test_message = 'Salesforce object catalogue refreshed', updated_at = now()
     where id = $1 and tenant_id = $2 and connector_type = 'salesforce'`,
    [input.connectorId, input.tenantId, JSON.stringify({
      apiVersion: input.apiVersion,
      catalog: input.catalog,
      catalogRefreshedAt: new Date().toISOString(),
    })],
  );
  if (result.rowCount !== 1) throw new Error("The Salesforce connection could not be updated.");
}

function mappingForField(field: SalesforceFieldSummary, position: number): PipelineFieldMapping {
  return {
    sourceField: field.name,
    targetField: field.name,
    dataType: field.dataType,
    isIncluded: true,
    isRequired: field.name === "Id",
    position,
  };
}

export async function createSalesforceObjectPipeline(
  client: PoolClient,
  input: {
    tenantId: string;
    connectorId: string;
    createdBy: string;
    pipelineName: string;
    description: SalesforceObjectDescription;
    selectedFields: string[];
    apiVersion: string;
    initialLookbackSeconds: number | null;
    overlapSeconds: number;
    pollIntervalMinutes: number;
  },
): Promise<{ pipelineId: string }> {
  const { rows: [connector] } = await client.query(
    `select id from public.connectors
     where id = $1 and tenant_id = $2 and connector_type = 'salesforce'
       and status in ('active', 'error') for update`,
    [input.connectorId, input.tenantId],
  );
  if (!connector) throw new Error("The Salesforce connection was not found.");
  const fieldByName = new Map(input.description.fields.map((field) => [field.name, field]));
  const selected = [...new Set(input.selectedFields)];
  for (const required of ["Id", input.description.modifiedField]) {
    if (!selected.includes(required)) selected.push(required);
  }
  if (input.description.supportsDeleted && !selected.includes("IsDeleted")) selected.push("IsDeleted");
  if (selected.length > 250) throw new Error("Select no more than 250 Salesforce fields.");
  const unknown = selected.filter((field) => !fieldByName.has(field));
  if (unknown.length > 0) throw new Error(`Salesforce fields are no longer queryable: ${unknown.join(", ")}.`);
  const sourceConfig = {
    object: input.description.name,
    objectLabel: input.description.label,
    fields: selected,
    modifiedField: input.description.modifiedField,
    includeDeleted: input.description.supportsDeleted,
    apiVersion: input.apiVersion,
    initialLookbackSeconds: input.initialLookbackSeconds,
  };
  const scheduleCron = input.pollIntervalMinutes === 60
    ? "0 * * * *"
    : input.pollIntervalMinutes === 1440
      ? "0 0 * * *"
      : `0 */${input.pollIntervalMinutes / 60} * * *`;
  const { rows: [pipeline] } = await client.query(
    `insert into public.pipelines
       (tenant_id, connector_id, name, status, source_config, load_mode,
        key_columns, schedule_cron, created_by)
     values ($1, $2, $3, 'active', $4::jsonb, 'upsert', array['Id']::text[], $5, $6)
     returning id`,
    [input.tenantId, input.connectorId, input.pipelineName, JSON.stringify(sourceConfig), scheduleCron, input.createdBy],
  );
  await client.query(
    `insert into public.pipeline_checkpoints
       (pipeline_id, tenant_id, strategy, overlap_seconds)
     values ($1, $2, 'modified_since', $3)`,
    [pipeline.id, input.tenantId, input.overlapSeconds],
  );
  await client.query(
    `insert into public.pipeline_sync_state
       (pipeline_id, tenant_id, poll_interval_minutes)
     values ($1, $2, $3)`,
    [pipeline.id, input.tenantId, input.pollIntervalMinutes],
  );
  const mappings = selected.map((name, position) => mappingForField(fieldByName.get(name)!, position));
  await client.query(
    `insert into public.pipeline_field_mappings
       (tenant_id, pipeline_id, source_field, target_field, data_type,
        is_included, is_required, position)
     select $1, $2, item.source_field, item.target_field, item.data_type,
            item.is_included, item.is_required, item.position
     from jsonb_to_recordset($3::jsonb) as item(
       source_field text, target_field text, data_type text,
       is_included boolean, is_required boolean, position integer
     )`,
    [input.tenantId, pipeline.id, JSON.stringify(mappings.map((mapping) => ({
      source_field: mapping.sourceField,
      target_field: mapping.targetField,
      data_type: mapping.dataType,
      is_included: mapping.isIncluded,
      is_required: mapping.isRequired,
      position: mapping.position,
    })))],
  );
  return { pipelineId: pipeline.id };
}

export async function getSalesforceSyncContext(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<SalesforceSyncContext> {
  const { rows: [row] } = await client.query(
    `select c.id as connector_id, c.config as connector_config,
            p.id as pipeline_id, p.name as pipeline_name, p.source_config,
            p.load_mode, p.key_columns,
            pc.overlap_seconds, pc.committed_through_at,
            cc.ciphertext, cc.iv, cc.auth_tag, cc.key_version
     from public.pipelines p
     join public.connectors c
       on c.id = p.connector_id and c.tenant_id = p.tenant_id
     join public.connector_credentials cc
       on cc.connector_id = c.id and cc.tenant_id = c.tenant_id
     join public.pipeline_checkpoints pc
       on pc.pipeline_id = p.id and pc.tenant_id = p.tenant_id
     join public.pipeline_sync_state pss
       on pss.pipeline_id = p.id and pss.tenant_id = p.tenant_id
     where p.id = $1 and p.tenant_id = $2 and p.status = 'active'
       and c.connector_type = 'salesforce' and c.status in ('active', 'error')
       and pc.strategy = 'modified_since'`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("The Salesforce pipeline was not found or is not active.");
  const source = row.source_config as Record<string, unknown>;
  const connectorConfig = row.connector_config as Record<string, unknown>;
  const fields = Array.isArray(source.fields) ? source.fields.filter((field): field is string => typeof field === "string") : [];
  if (!source.object || !source.modifiedField || fields.length === 0 || !connectorConfig.apiVersion) {
    throw new Error("The Salesforce pipeline configuration is incomplete.");
  }
  const fieldMappings = await listPipelineFieldMappings(client, input);
  return {
    connectorId: row.connector_id,
    credentials: openSalesforceCredentials(row, { tenantId: input.tenantId, connectorId: row.connector_id }),
    apiVersion: String(connectorConfig.apiVersion),
    pipeline: {
      id: row.pipeline_id,
      connectorId: row.connector_id,
      name: row.pipeline_name,
      loadMode: "upsert",
      keyColumns: ["Id"],
      fieldMappings,
    },
    objectName: String(source.object),
    fields,
    modifiedField: String(source.modifiedField),
    includeDeleted: source.includeDeleted === true,
    initialLookbackSeconds: typeof source.initialLookbackSeconds === "number" ? source.initialLookbackSeconds : null,
    overlapSeconds: Number(row.overlap_seconds),
    committedThroughAt: row.committed_through_at ? new Date(row.committed_through_at).toISOString() : null,
  };
}

export async function acquireSalesforceSyncLease(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<string> {
  const { rows: [row] } = await client.query(
    `update public.pipeline_sync_state set
       lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes', updated_at = now()
     where pipeline_id = $1 and tenant_id = $2
       and (lease_expires_at is null or lease_expires_at <= now())
     returning lease_token`,
    [input.pipelineId, input.tenantId],
  );
  if (!row) throw new Error("This Salesforce object is already synchronizing.");
  return row.lease_token;
}

export async function commitSalesforceSyncSuccess(
  client: PoolClient,
  input: {
    tenantId: string;
    connectorId: string;
    pipelineId: string;
    expectedCommittedThroughAt: string | null;
    committedThroughAt: string;
    leaseToken: string;
  },
): Promise<void> {
  const checkpoint = await client.query(
    `update public.pipeline_checkpoints set
       committed_through_at = $3::timestamptz,
       cursor_value = jsonb_build_object('committedThroughAt', ($3::timestamptz)::text),
       updated_at = now()
     where pipeline_id = $1 and tenant_id = $2
       and committed_through_at is not distinct from $4::timestamptz
     returning pipeline_id`,
    [input.pipelineId, input.tenantId, input.committedThroughAt, input.expectedCommittedThroughAt],
  );
  if (checkpoint.rowCount !== 1) throw new Error("The Salesforce checkpoint changed while this run was active.");
  const state = await client.query(
    `update public.pipeline_sync_state set
       last_polled_at = now(), last_success_at = now(), last_error = null,
       consecutive_failures = 0, next_retry_at = null,
       next_poll_at = now() + make_interval(mins => poll_interval_minutes),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where pipeline_id = $1 and tenant_id = $2 and lease_token = $3
     returning pipeline_id`,
    [input.pipelineId, input.tenantId, input.leaseToken],
  );
  if (state.rowCount !== 1) throw new Error("The Salesforce sync lease expired before the checkpoint committed.");
  await client.query(
    `update public.connectors set status = 'active', last_tested_at = now(),
       last_test_status = 'succeeded', last_test_message = 'Salesforce pipeline synchronized', updated_at = now()
     where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId],
  );
}

export async function recordSalesforceSyncFailure(
  client: PoolClient,
  input: { tenantId: string; connectorId: string; pipelineId: string; leaseToken: string; message: string },
): Promise<void> {
  const message = input.message.slice(0, 500);
  await client.query(
    `update public.pipeline_sync_state set
       last_polled_at = now(), last_error = $4,
       consecutive_failures = consecutive_failures + 1,
       next_retry_at = now() + make_interval(mins => least(60, power(2, least(consecutive_failures, 5))::integer * 5)),
       lease_token = null, lease_expires_at = null, updated_at = now()
     where pipeline_id = $1 and tenant_id = $2 and lease_token = $3`,
    [input.pipelineId, input.tenantId, input.leaseToken, message],
  );
  await client.query(
    `update public.connectors set status = 'error', last_tested_at = now(),
       last_test_status = 'failed', last_test_message = $3, updated_at = now()
     where id = $1 and tenant_id = $2`,
    [input.connectorId, input.tenantId, message],
  );
}
