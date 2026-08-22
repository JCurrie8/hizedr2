"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import {
  createManualFilePipeline,
  getManualFilePipeline,
  persistManualFileFailure,
  persistManualFileRun,
} from "@/server/domains/connectors/connectors";
import { parseTabularFile } from "@/server/domains/connectors/tabular-file";
import { resolveMicrosoftWorkbook } from "@/server/domains/connectors/microsoft-graph";
import {
  createMicrosoftAuthorizationUrl,
  createMicrosoftOAuthState,
  ensureFreshMicrosoftCredentials,
  microsoftConnectorEnvironmentReady,
} from "@/server/domains/connectors/microsoft-oauth";
import {
  configureMicrosoftWorkbookPipeline,
  getMicrosoftConnectorCredentials,
  replaceMicrosoftConnectorCredentials,
} from "@/server/domains/connectors/sharepoint-connectors";
import { syncSharePointWorkbook } from "@/server/domains/connectors/sharepoint-sync";
import {
  authenticateSalesforce,
  describeSalesforceObject,
  discoverSalesforceObjects,
  normalizeSalesforceDomain,
  resolveSalesforceApiVersion,
} from "@/server/domains/connectors/salesforce-api";
import {
  createSalesforceConnector,
  createSalesforceObjectPipeline,
  getSalesforceConnectorCredentials,
  replaceSalesforceCatalog,
} from "@/server/domains/connectors/salesforce-connectors";
import { syncSalesforcePipeline } from "@/server/domains/connectors/salesforce-sync";
import {
  describeSqlServerObject,
  discoverSqlServerObjects,
  normalizeSqlServerHost,
  testSqlServerConnection,
} from "@/server/domains/connectors/sql-server-api";
import { testSqlServerDestination } from "@/server/domains/connectors/sql-server-destination-api";
import {
  configurePipelineSqlDestination,
  createSqlServerDestination,
  getSqlDestinationValidationContext,
} from "@/server/domains/connectors/sql-server-destinations";
import {
  approveSqlTransformationVersion,
  getPipelineSqlTransformationVersion,
  registerSqlTransformationVersion,
  sqlTransformationColumnSignature,
  sqlTransformationSignaturesMatch,
} from "@/server/domains/connectors/sql-server-transformations";
import { syncPipelineToSqlDestination } from "@/server/domains/connectors/sql-server-destination-sync";
import {
  acquireSqlPublicationLease,
  completeSqlPublication,
  createSqlPublication,
  failSqlPublication,
} from "@/server/domains/connectors/sql-server-publications";
import {
  createSqlServerConnector,
  createSqlServerPipeline,
  getSqlServerCredentials,
  type SqlServerConnectorType,
} from "@/server/domains/connectors/sql-server-connectors";
import { syncSqlServerPipeline } from "@/server/domains/connectors/sql-server-sync";
import {
  createR2Upload,
  deleteR2Object,
  downloadR2Object,
  verifyR2Upload,
} from "@/server/storage/r2";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

async function requireConnectOperator() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    throw new Error("Only a company admin or analyst can configure Connect.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" }),
  );
  return ctx;
}

async function requireCompanyAdmin() {
  const ctx = await requireConnectOperator();
  if (ctx.role !== "company_admin") throw new Error("Only a company admin can save connection credentials.");
  return ctx;
}

function validateUploadInput(input: {
  pipelineId: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
}) {
  if (!UUID_PATTERN.test(input.pipelineId)) throw new Error("Invalid pipeline.");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error("Files must be between 1 byte and 10 MB.");
  }
  if (!SHA256_PATTERN.test(input.contentSha256)) throw new Error("Invalid file hash.");
  const extension = input.fileName.toLocaleLowerCase("en-GB").split(".").pop();
  if (extension !== "csv" && extension !== "xlsx") throw new Error("Only .csv and .xlsx files are supported.");
  return extension;
}

function safeStorageFileName(fileName: string): string {
  const leaf = fileName.replaceAll("\\", "/").split("/").pop() ?? "upload";
  return leaf.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "upload";
}

export async function createManualFilePipelineAction(formData: FormData) {
  const ctx = await requireConnectOperator();

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Pipeline name must be between 2 and 100 characters.");
  const rawLoadMode = String(formData.get("loadMode") ?? "snapshot");
  if (!(["snapshot", "append", "upsert"] as const).includes(rawLoadMode as "snapshot")) {
    throw new Error("Invalid load mode.");
  }
  const loadMode = rawLoadMode as "snapshot" | "append" | "upsert";
  const keyColumns = String(formData.get("keyColumns") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (loadMode === "upsert" && keyColumns.length === 0) {
    throw new Error("Upsert pipelines require at least one key column.");
  }

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createManualFilePipeline(client, {
      tenantId: ctx.tenant.id,
      createdBy: ctx.profileId,
      name,
      loadMode,
      keyColumns,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.pipeline_created",
      targetType: "pipeline",
      targetId: created.pipelineId,
      metadata: { connectorId: created.connectorId, connectorType: "file_upload", loadMode, keyColumns },
    });
  });

  revalidatePath("/admin/connect");
}

function parsePipelineConfig(formData: FormData) {
  const pipelineName = String(formData.get("pipelineName") ?? "").trim();
  if (pipelineName.length < 2 || pipelineName.length > 100) {
    throw new Error("Pipeline name must be between 2 and 100 characters.");
  }
  const rawLoadMode = String(formData.get("loadMode") ?? "snapshot");
  if (!("snapshot" === rawLoadMode || "append" === rawLoadMode || "upsert" === rawLoadMode)) {
    throw new Error("Invalid load mode.");
  }
  const loadMode = rawLoadMode as "snapshot" | "append" | "upsert";
  const keyColumns = String(formData.get("keyColumns") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (loadMode === "upsert" && keyColumns.length === 0) {
    throw new Error("Upsert pipelines require at least one key column, such as Response ID.");
  }
  return { pipelineName, loadMode, keyColumns };
}

export async function beginMicrosoftConnectionAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!microsoftConnectorEnvironmentReady()) {
    throw new Error("Microsoft Connect is not configured in this deployment yet.");
  }
  const connectorName = String(formData.get("name") ?? "").trim();
  if (connectorName.length < 2 || connectorName.length > 100) {
    throw new Error("Connection name must be between 2 and 100 characters.");
  }
  const state = createMicrosoftOAuthState({
    tenantId: ctx.tenant.id,
    tenantSlug: ctx.tenant.slug,
    profileId: ctx.profileId,
    connectorName,
  });
  redirect(createMicrosoftAuthorizationUrl(state));
}

export async function configureMicrosoftWorkbookAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const connectorId = String(formData.get("connectorId") ?? "");
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Invalid Microsoft connector.");
  const sourceKind = String(formData.get("sourceKind") ?? "sharepoint");
  if (sourceKind !== "sharepoint" && sourceKind !== "onedrive") throw new Error("Invalid Microsoft source type.");
  const workbookPath = String(formData.get("workbookPath") ?? "").trim();
  if (workbookPath.length < 3 || workbookPath.length > 1_000) throw new Error("Enter the workbook path.");
  const siteUrl = String(formData.get("siteUrl") ?? "").trim();
  const pipelineConfig = parsePipelineConfig(formData);

  const credentials = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getMicrosoftConnectorCredentials(client, { tenantId: ctx.tenant.id, connectorId }),
  );
  const fresh = await ensureFreshMicrosoftCredentials(credentials);
  if (fresh.refreshed) {
    await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => replaceMicrosoftConnectorCredentials(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        credentials: fresh.credentials,
      }),
    );
  }
  const source = await resolveMicrosoftWorkbook({
    accessToken: fresh.credentials.accessToken,
    sourceKind,
    workbookPath,
    siteUrl: siteUrl || undefined,
  });
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const created = await configureMicrosoftWorkbookPipeline(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        createdBy: ctx.profileId,
        ...pipelineConfig,
        source,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sharepoint_pipeline_configured",
        targetType: "pipeline",
        targetId: created.pipelineId,
        metadata: {
          connectorId,
          sourceKind,
          driveId: source.driveId,
          driveItemId: source.driveItemId,
          sourceName: source.sourceName,
          loadMode: pipelineConfig.loadMode,
          keyColumns: pipelineConfig.keyColumns,
        },
      });
    },
  );
  revalidatePath("/admin/connect");
}

export async function syncMicrosoftWorkbookAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const pipelineId = String(formData.get("pipelineId") ?? "");
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid SharePoint pipeline.");
  await syncSharePointWorkbook({ tenantId: ctx.tenant.id, actorUserId: ctx.profileId, pipelineId });
  revalidatePath("/admin/connect");
}

export async function createSalesforceConnectionAction(formData: FormData) {
  const ctx = await requireCompanyAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Connection name must be between 2 and 100 characters.");
  const credentials = {
    myDomainUrl: normalizeSalesforceDomain(String(formData.get("myDomainUrl") ?? "")),
    clientId: String(formData.get("clientId") ?? "").trim(),
    clientSecret: String(formData.get("clientSecret") ?? "").trim(),
  };
  if (credentials.clientId.length < 10 || credentials.clientId.length > 500) throw new Error("Enter a valid Salesforce consumer key.");
  if (credentials.clientSecret.length < 10 || credentials.clientSecret.length > 500) throw new Error("Enter a valid Salesforce consumer secret.");
  const session = await authenticateSalesforce(credentials);
  const requestedVersion = String(formData.get("apiVersion") ?? "").trim() || undefined;
  const apiVersion = await resolveSalesforceApiVersion(session, requestedVersion);
  const catalog = await discoverSalesforceObjects(session, apiVersion);
  if (catalog.length === 0) throw new Error("The Salesforce integration user cannot query any objects.");

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createSalesforceConnector(client, {
      tenantId: ctx.tenant.id,
      createdBy: ctx.profileId,
      name,
      credentials,
      apiVersion,
      catalog,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.salesforce_connected",
      targetType: "connector",
      targetId: created.connectorId,
      metadata: { myDomainUrl: credentials.myDomainUrl, apiVersion, queryableObjects: catalog.length },
    });
  });
  revalidatePath("/admin/connect");
}

export async function refreshSalesforceCatalogAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const connectorId = String(formData.get("connectorId") ?? "");
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Invalid Salesforce connection.");
  const stored = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getSalesforceConnectorCredentials(client, { tenantId: ctx.tenant.id, connectorId }),
  );
  const session = await authenticateSalesforce(stored.credentials);
  const apiVersion = await resolveSalesforceApiVersion(session, stored.apiVersion);
  const catalog = await discoverSalesforceObjects(session, apiVersion);
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await replaceSalesforceCatalog(client, { tenantId: ctx.tenant.id, connectorId, apiVersion, catalog });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.salesforce_catalog_refreshed",
      targetType: "connector",
      targetId: connectorId,
      metadata: { apiVersion, queryableObjects: catalog.length },
    });
  });
  revalidatePath("/admin/connect");
}

export async function createSalesforcePipelineAction(connectorId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Invalid Salesforce connection.");
  const objectName = String(formData.get("objectName") ?? "").trim();
  const pipelineName = String(formData.get("pipelineName") ?? "").trim();
  if (pipelineName.length < 2 || pipelineName.length > 100) throw new Error("Pipeline name must be between 2 and 100 characters.");
  const selectedFields = formData.getAll("fields").map(String);
  if (selectedFields.length === 0 || selectedFields.length > 250) throw new Error("Select between 1 and 250 Salesforce fields.");
  const rawInitialHistory = String(formData.get("initialHistory") ?? "full");
  const initialLookbackSeconds = rawInitialHistory === "full" ? null : Number(rawInitialHistory) * 86_400;
  if (initialLookbackSeconds !== null && (!Number.isInteger(initialLookbackSeconds) || initialLookbackSeconds < 86_400 || initialLookbackSeconds > 315_360_000)) {
    throw new Error("Invalid Salesforce bootstrap window.");
  }
  const pollIntervalMinutes = Number(formData.get("pollIntervalMinutes") ?? 1440);
  if (![60, 180, 360, 720, 1440].includes(pollIntervalMinutes)) throw new Error("Invalid Salesforce refresh interval.");
  const stored = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getSalesforceConnectorCredentials(client, { tenantId: ctx.tenant.id, connectorId }),
  );
  const session = await authenticateSalesforce(stored.credentials);
  const description = await describeSalesforceObject(session, stored.apiVersion, objectName);
  const created = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const pipeline = await createSalesforceObjectPipeline(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        createdBy: ctx.profileId,
        pipelineName,
        description,
        selectedFields,
        apiVersion: stored.apiVersion,
        initialLookbackSeconds,
        overlapSeconds: 86_400,
        pollIntervalMinutes,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.salesforce_pipeline_created",
        targetType: "pipeline",
        targetId: pipeline.pipelineId,
        metadata: {
          connectorId,
          object: description.name,
          fields: selectedFields.length,
          modifiedField: description.modifiedField,
          initialLookbackSeconds,
          overlapSeconds: 86_400,
          pollIntervalMinutes,
        },
      });
      return pipeline;
    },
  );
  revalidatePath("/admin/connect");
  revalidatePath(`/admin/connect/pipelines/${created.pipelineId}`);
}

export async function syncSalesforcePipelineAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const pipelineId = String(formData.get("pipelineId") ?? "");
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid Salesforce pipeline.");
  await syncSalesforcePipeline({
    tenantId: ctx.tenant.id,
    actorUserId: ctx.profileId,
    pipelineId,
    triggerType: "manual_sync",
  });
  revalidatePath("/admin/connect");
}

export async function createSqlServerConnectionAction(formData: FormData) {
  const ctx = await requireCompanyAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Connection name must be between 2 and 100 characters.");
  const connectorType = String(formData.get("connectorType") ?? "sql_server") as SqlServerConnectorType;
  if (connectorType !== "sql_server" && connectorType !== "azure_sql") throw new Error("Choose SQL Server or Azure SQL.");
  const credentials = {
    server: normalizeSqlServerHost(String(formData.get("server") ?? "")),
    port: Number(formData.get("port") ?? 1433),
    database: String(formData.get("database") ?? "").trim(),
    username: String(formData.get("username") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
  if (!Number.isInteger(credentials.port) || credentials.port < 1 || credentials.port > 65_535) throw new Error("Enter a valid SQL Server TCP port.");
  if (credentials.database.length < 1 || credentials.database.length > 128) throw new Error("Enter a valid database name.");
  if (credentials.username.length < 1 || credentials.username.length > 128) throw new Error("Enter a dedicated read-only SQL login.");
  if (credentials.password.length < 8 || credentials.password.length > 500) throw new Error("Enter the SQL login password.");
  const identity = await testSqlServerConnection(credentials);
  const catalog = await discoverSqlServerObjects(credentials);
  if (catalog.length === 0) throw new Error("The read-only login cannot browse any tables or views.");

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createSqlServerConnector(client, {
      tenantId: ctx.tenant.id,
      createdBy: ctx.profileId,
      name,
      connectorType,
      credentials,
      serverVersion: identity.serverVersion,
      catalog,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.sql_server_connected",
      targetType: "connector",
      targetId: created.connectorId,
      metadata: {
        connectorType,
        server: credentials.server,
        port: credentials.port,
        database: identity.database,
        visibleObjects: catalog.length,
        tls: "validated",
      },
    });
  });
  revalidatePath("/admin/connect");
}

export async function createSqlServerDestinationAction(formData: FormData) {
  const ctx = await requireCompanyAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Destination name must be between 2 and 100 characters.");
  const connectorType = String(formData.get("connectorType") ?? "sql_server") as SqlServerConnectorType;
  if (connectorType !== "sql_server" && connectorType !== "azure_sql") throw new Error("Choose SQL Server or Azure SQL.");
  const managedSchema = String(formData.get("managedSchema") ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(managedSchema)) {
    throw new Error("The managed schema must start with a letter or underscore and contain only letters, numbers and underscores.");
  }
  const credentials = {
    server: normalizeSqlServerHost(String(formData.get("server") ?? "")),
    port: Number(formData.get("port") ?? 1433),
    database: String(formData.get("database") ?? "").trim(),
    username: String(formData.get("username") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
  if (!Number.isInteger(credentials.port) || credentials.port < 1 || credentials.port > 65_535) throw new Error("Enter a valid SQL Server TCP port.");
  if (credentials.database.length < 1 || credentials.database.length > 128) throw new Error("Enter a valid database name.");
  if (credentials.username.length < 1 || credentials.username.length > 128) throw new Error("Enter a dedicated schema-scoped SQL loader login.");
  if (credentials.password.length < 8 || credentials.password.length > 500) throw new Error("Enter the SQL loader password.");
  const identity = await testSqlServerDestination(credentials, managedSchema);

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const created = await createSqlServerDestination(client, {
      tenantId: ctx.tenant.id,
      createdBy: ctx.profileId,
      name,
      connectorType,
      credentials,
      managedSchema: identity.managedSchema,
      serverVersion: identity.serverVersion,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "connect.sql_destination_connected",
      targetType: "connector",
      targetId: created.connectorId,
      metadata: {
        connectorType,
        server: credentials.server,
        port: credentials.port,
        database: identity.database,
        managedSchema: identity.managedSchema,
        permissionBoundary: "managed_schema_only",
        tls: "validated",
      },
    });
  });
  revalidatePath("/admin/connect");
}

export async function configurePipelineSqlDestinationAction(pipelineId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid source pipeline.");
  const connectorId = String(formData.get("connectorId") ?? "");
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Choose a SQL workbench destination.");
  const targetTable = String(formData.get("targetTable") ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(targetTable)) {
    throw new Error("The target table must start with a letter or underscore and contain only letters, numbers and underscores.");
  }
  const scheduleValue = String(formData.get("scheduleIntervalMinutes") ?? "manual");
  const scheduleIntervalMinutes = scheduleValue === "manual" ? null : Number(scheduleValue);
  if (scheduleIntervalMinutes !== null && ![60, 180, 360, 720, 1440].includes(scheduleIntervalMinutes)) {
    throw new Error("Choose a supported SQL workbench delivery schedule.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const result = await configurePipelineSqlDestination(client, {
        tenantId: ctx.tenant.id,
        pipelineId,
        connectorId,
        targetTable,
        createdBy: ctx.profileId,
        scheduleIntervalMinutes,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sql_destination_configured",
        targetType: "pipeline",
        targetId: pipelineId,
        metadata: {
          destinationId: result.destinationId,
          connectorId,
          targetTable,
          loadMode: "snapshot",
          scheduleIntervalMinutes,
        },
      });
      return result;
    },
  );
  revalidatePath(`/admin/connect/pipelines/${pipelineId}`);
}

export async function syncPipelineToSqlDestinationAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const pipelineId = String(formData.get("pipelineId") ?? "");
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid source pipeline.");
  await syncPipelineToSqlDestination({ tenantId: ctx.tenant.id, actorUserId: ctx.profileId, pipelineId });
  revalidatePath("/admin/connect");
  revalidatePath(`/admin/connect/pipelines/${pipelineId}`);
}

export async function registerSqlTransformationVersionAction(pipelineId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid source pipeline.");
  const objectSchema = String(formData.get("objectSchema") ?? "").trim();
  const objectName = String(formData.get("objectName") ?? "").trim();
  const changeNote = String(formData.get("changeNote") ?? "").trim();
  const destination = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getSqlDestinationValidationContext(client, { tenantId: ctx.tenant.id, pipelineId }),
  );
  if (objectSchema.toLocaleLowerCase("en-GB") !== destination.managedSchema.toLocaleLowerCase("en-GB")) {
    throw new Error(`Register the transformed table or view inside the managed ${destination.managedSchema} schema.`);
  }
  if (objectName.toLocaleLowerCase("en-GB") === destination.targetTable.toLocaleLowerCase("en-GB")) {
    throw new Error("Register a transformed table or view, not the raw landing table.");
  }
  const description = await describeSqlServerObject(destination.credentials, {
    schema: objectSchema,
    object: objectName,
  });
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const version = await registerSqlTransformationVersion(client, {
        tenantId: ctx.tenant.id,
        destinationId: destination.destinationId,
        actorUserId: ctx.profileId,
        description,
        changeNote,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sql_transformation_version_created",
        targetType: "pipeline",
        targetId: pipelineId,
        metadata: {
          destinationId: destination.destinationId,
          transformationId: version.id,
          versionNumber: version.versionNumber,
          objectSchema: description.schema,
          objectName: description.name,
          objectType: description.objectType,
          fieldCount: description.fields.length,
        },
      });
      return version;
    },
  );
  revalidatePath(`/admin/connect/pipelines/${pipelineId}`);
}

export async function approveSqlTransformationVersionAction(pipelineId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (ctx.role !== "company_admin") throw new Error("Only a Company Admin can approve a SQL transformation.");
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid source pipeline.");
  const transformationId = String(formData.get("transformationId") ?? "");
  if (!UUID_PATTERN.test(transformationId)) throw new Error("Invalid SQL transformation version.");
  const { transformation, destination } = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => ({
      transformation: await getPipelineSqlTransformationVersion(client, {
        tenantId: ctx.tenant.id,
        pipelineId,
        transformationId,
      }),
      destination: await getSqlDestinationValidationContext(client, { tenantId: ctx.tenant.id, pipelineId }),
    }),
  );
  if (transformation.status !== "draft") throw new Error("Only a draft SQL transformation can be approved.");
  const currentDescription = await describeSqlServerObject(destination.credentials, {
    schema: transformation.objectSchema,
    object: transformation.objectName,
  });
  const currentSignature = sqlTransformationColumnSignature(currentDescription);
  if (
    currentDescription.objectType !== transformation.objectType
    || !sqlTransformationSignaturesMatch(currentSignature, transformation.columnSignature)
  ) {
    throw new Error("The SQL object changed after validation. Register a new version before approval.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const version = await approveSqlTransformationVersion(client, {
        tenantId: ctx.tenant.id,
        transformationId,
        actorUserId: ctx.profileId,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sql_transformation_approved",
        targetType: "pipeline",
        targetId: pipelineId,
        metadata: {
          destinationId: version.destinationId,
          transformationId: version.id,
          versionNumber: version.versionNumber,
          objectSchema: transformation.objectSchema,
          objectName: transformation.objectName,
          objectType: transformation.objectType,
          fieldCount: transformation.columnSignature.length,
        },
      });
      return version;
    },
  );
  revalidatePath(`/admin/connect/pipelines/${pipelineId}`);
}

export async function createApprovedSqlPublicationAction(pipelineId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid source pipeline.");
  const transformationId = String(formData.get("transformationId") ?? "");
  const connectorId = String(formData.get("connectorId") ?? "");
  if (!UUID_PATTERN.test(transformationId) || !UUID_PATTERN.test(connectorId)) {
    throw new Error("Choose an approved transformation and read-only SQL connection.");
  }
  const pipelineName = String(formData.get("pipelineName") ?? "").trim();
  if (pipelineName.length < 2 || pipelineName.length > 100) throw new Error("Publication pipeline name must be between 2 and 100 characters.");
  const scheduleValue = String(formData.get("scheduleIntervalMinutes") ?? "manual");
  const scheduleIntervalMinutes = scheduleValue === "manual" ? null : Number(scheduleValue);
  if (scheduleIntervalMinutes !== null && ![60, 180, 360, 720, 1440].includes(scheduleIntervalMinutes)) {
    throw new Error("Choose a supported Hized publication schedule.");
  }
  const { transformation, destination, publisher } = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => ({
      transformation: await getPipelineSqlTransformationVersion(client, {
        tenantId: ctx.tenant.id,
        pipelineId,
        transformationId,
      }),
      destination: await getSqlDestinationValidationContext(client, { tenantId: ctx.tenant.id, pipelineId }),
      publisher: await getSqlServerCredentials(client, { tenantId: ctx.tenant.id, connectorId }),
    }),
  );
  if (transformation.status !== "approved") throw new Error("Only the currently approved SQL transformation can be published.");
  if (
    destination.credentials.server.toLocaleLowerCase("en-GB") !== publisher.credentials.server.toLocaleLowerCase("en-GB")
    || destination.credentials.database.toLocaleLowerCase("en-GB") !== publisher.credentials.database.toLocaleLowerCase("en-GB")
    || destination.credentials.port !== publisher.credentials.port
  ) {
    throw new Error("The read-only publisher must connect to the same SQL server and database as the workbench.");
  }
  const description = await describeSqlServerObject(publisher.credentials, {
    schema: transformation.objectSchema,
    object: transformation.objectName,
  });
  if (
    description.objectType !== transformation.objectType
    || !sqlTransformationSignaturesMatch(sqlTransformationColumnSignature(description), transformation.columnSignature)
  ) {
    throw new Error("The read-only connection sees a different SQL object signature. Revalidate the transformation before publication.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const pipeline = await createSqlServerPipeline(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        createdBy: ctx.profileId,
        pipelineName,
        description,
        selectedFields: description.fields.map((field) => field.name),
        keyColumns: [],
        watermarkField: null,
        loadMode: "snapshot",
        overlapSeconds: 0,
        approvedTransformationId: transformation.id,
      });
      const publication = await createSqlPublication(client, {
        tenantId: ctx.tenant.id,
        transformationId: transformation.id,
        pipelineId: pipeline.pipelineId,
        createdBy: ctx.profileId,
        scheduleIntervalMinutes,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sql_publication_configured",
        targetType: "pipeline",
        targetId: pipeline.pipelineId,
        metadata: {
          sourcePipelineId: pipelineId,
          transformationId: transformation.id,
          transformationVersion: transformation.versionNumber,
          publicationId: publication.publicationId,
          connectorId,
          scheduleIntervalMinutes,
          loadMode: "snapshot",
        },
      });
    },
  );
  revalidatePath(`/admin/connect/pipelines/${pipelineId}`);
  revalidatePath("/admin/connect");
}

export async function syncApprovedSqlPublicationAction(workbenchPipelineId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(workbenchPipelineId)) throw new Error("Invalid source pipeline.");
  const publicationId = String(formData.get("publicationId") ?? "");
  if (!UUID_PATTERN.test(publicationId)) throw new Error("Invalid approved SQL publication.");
  const publication = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => acquireSqlPublicationLease(client, { tenantId: ctx.tenant.id, publicationId }),
  );
  try {
    await syncSqlServerPipeline({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      pipelineId: publication.pipelineId,
    });
    await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => completeSqlPublication(client, {
        tenantId: ctx.tenant.id,
        publicationId,
        leaseToken: publication.leaseToken,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The approved SQL publication failed.";
    await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => failSqlPublication(client, {
        tenantId: ctx.tenant.id,
        publicationId,
        leaseToken: publication.leaseToken,
        message,
      }),
    ).catch(() => {});
    throw error;
  }
  revalidatePath(`/admin/connect/pipelines/${workbenchPipelineId}`);
  revalidatePath("/admin/connect");
}

export async function createSqlServerPipelineAction(connectorId: string, formData: FormData) {
  const ctx = await requireConnectOperator();
  if (!UUID_PATTERN.test(connectorId)) throw new Error("Invalid SQL Server connection.");
  const schema = String(formData.get("schema") ?? "").trim();
  const object = String(formData.get("object") ?? "").trim();
  const pipelineName = String(formData.get("pipelineName") ?? "").trim();
  if (pipelineName.length < 2 || pipelineName.length > 100) throw new Error("Pipeline name must be between 2 and 100 characters.");
  const selectedFields = [...new Set(formData.getAll("fields").map(String))];
  const keyColumns = [...new Set(formData.getAll("keyColumns").map(String))];
  const watermarkField = String(formData.get("watermarkField") ?? "").trim() || null;
  const loadMode = String(formData.get("loadMode") ?? "snapshot");
  if (loadMode !== "snapshot" && loadMode !== "upsert") throw new Error("Choose snapshot or upsert loading.");
  const stored = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getSqlServerCredentials(client, { tenantId: ctx.tenant.id, connectorId }),
  );
  const description = await describeSqlServerObject(stored.credentials, { schema, object });
  const created = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const pipeline = await createSqlServerPipeline(client, {
        tenantId: ctx.tenant.id,
        connectorId,
        createdBy: ctx.profileId,
        pipelineName,
        description,
        selectedFields,
        keyColumns,
        watermarkField,
        loadMode,
        overlapSeconds: watermarkField ? 86_400 : 0,
      });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "connect.sql_server_pipeline_created",
        targetType: "pipeline",
        targetId: pipeline.pipelineId,
        metadata: {
          connectorId,
          connectorType: stored.connectorType,
          schema,
          object,
          selectedFields: selectedFields.length,
          keyColumns,
          watermarkField,
          loadMode,
        },
      });
      return pipeline;
    },
  );
  revalidatePath("/admin/connect");
  revalidatePath(`/admin/connect/pipelines/${created.pipelineId}`);
}

export async function syncSqlServerPipelineAction(formData: FormData) {
  const ctx = await requireConnectOperator();
  const pipelineId = String(formData.get("pipelineId") ?? "");
  if (!UUID_PATTERN.test(pipelineId)) throw new Error("Invalid SQL Server pipeline.");
  await syncSqlServerPipeline({ tenantId: ctx.tenant.id, actorUserId: ctx.profileId, pipelineId });
  revalidatePath("/admin/connect");
}

export interface PreparedManualUpload {
  pipelineId: string;
  connectorId: string;
  storageKey: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

export async function prepareManualUploadAction(input: {
  pipelineId: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
  confirmSnapshotReplace: boolean;
}): Promise<PreparedManualUpload> {
  const ctx = await requireConnectOperator();
  const extension = validateUploadInput(input);
  const contentType = extension === "csv"
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pipeline = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getManualFilePipeline(client, { tenantId: ctx.tenant.id, pipelineId: input.pipelineId }),
  );
  if (pipeline.loadMode === "snapshot" && input.confirmSnapshotReplace !== true) {
    throw new Error("Confirm that this file should replace the current dataset before uploading.");
  }
  const day = new Date().toISOString().slice(0, 10);
  const storageKey = `${ctx.tenant.id}/connect/${pipeline.connectorId}/${day}/${randomUUID()}-${safeStorageFileName(input.fileName)}`;
  const upload = await createR2Upload({
    key: storageKey,
    contentType,
    metadata: {
      tenantId: ctx.tenant.id,
      pipelineId: pipeline.id,
      contentSha256: input.contentSha256,
    },
  });
  return {
    pipelineId: pipeline.id,
    connectorId: pipeline.connectorId,
    storageKey,
    uploadUrl: upload.uploadUrl,
    uploadHeaders: upload.headers,
    expiresAt: upload.expiresAt,
  };
}

export async function finaliseManualUploadAction(input: {
  pipelineId: string;
  connectorId: string;
  storageKey: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
  sourceLastModified: number | null;
  confirmSnapshotReplace: boolean;
}) {
  const ctx = await requireConnectOperator();
  const extension = validateUploadInput(input);
  const contentType = extension === "csv"
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pipeline = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => getManualFilePipeline(client, { tenantId: ctx.tenant.id, pipelineId: input.pipelineId }),
  );
  if (pipeline.loadMode === "snapshot" && input.confirmSnapshotReplace !== true) {
    throw new Error("Confirm that this file should replace the current dataset.");
  }
  if (pipeline.connectorId !== input.connectorId) throw new Error("The upload connector does not match the pipeline.");
  const requiredPrefix = `${ctx.tenant.id}/connect/${pipeline.connectorId}/`;
  if (!input.storageKey.startsWith(requiredPrefix) || input.storageKey.includes("..")) {
    throw new Error("The upload storage key is outside this tenant and connector.");
  }

  await verifyR2Upload({
    key: input.storageKey,
    sizeBytes: input.sizeBytes,
    metadata: {
      tenantId: ctx.tenant.id,
      pipelineId: pipeline.id,
      contentSha256: input.contentSha256,
    },
  });
  const bytes = await downloadR2Object(input.storageKey);
  const serverHash = createHash("sha256").update(bytes).digest("hex");
  if (serverHash !== input.contentSha256) throw new Error("The uploaded file hash does not match its content.");
  const sourceModifiedAt = input.sourceLastModified && Number.isFinite(input.sourceLastModified)
    ? new Date(input.sourceLastModified).toISOString()
    : null;
  const sourceInput = {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.profileId,
    pipeline,
    fileName: input.fileName,
    contentType,
    contentSha256: input.contentSha256,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    sourceModifiedAt,
  };

  let result;
  try {
    const table = await parseTabularFile({ bytes, fileName: input.fileName });
    result = await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        const persisted = await persistManualFileRun(client, { ...sourceInput, table });
        await insertAuditLog(client, {
          tenantId: ctx.tenant.id,
          actorUserId: ctx.profileId,
          action: persisted.duplicate ? "connect.upload_duplicate" : "connect.run_completed",
          targetType: "pipeline_run",
          targetId: persisted.runId,
          metadata: {
            pipelineId: pipeline.id,
            fileName: input.fileName,
            contentSha256: input.contentSha256,
            status: persisted.status,
            acceptedRows: persisted.acceptedRows,
            rejectedRows: persisted.rejectedRows,
          },
        });
        return persisted;
      },
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "The file could not be processed.";
    const failure = await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        const failed = await persistManualFileFailure(client, { ...sourceInput, errorMessage });
        await insertAuditLog(client, {
          tenantId: ctx.tenant.id,
          actorUserId: ctx.profileId,
          action: "connect.run_failed",
          targetType: "pipeline_run",
          targetId: failed.runId,
          metadata: {
            pipelineId: pipeline.id,
            fileName: input.fileName,
            contentSha256: input.contentSha256,
            error: errorMessage.slice(0, 500),
          },
        });
        return failed;
      },
    );
    if (failure.sourceObjectReused) await deleteR2Object(input.storageKey).catch(() => {});
    revalidatePath("/admin/connect");
    throw new Error(errorMessage);
  }

  if (result.sourceObjectReused) await deleteR2Object(input.storageKey).catch(() => {});
  revalidatePath("/admin/connect");
  return result;
}
