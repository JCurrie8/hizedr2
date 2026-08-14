import type { PipelineDataType } from "./tabular-load";

const SALESFORCE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const API_VERSION = /^\d{2}\.0$/;
const MAX_SELECTED_FIELDS = 250;
const MAX_REST_ROWS = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UNSUPPORTED_FIELD_TYPES = new Set(["address", "base64", "complexvalue", "location"]);

export interface SalesforceCredentials {
  myDomainUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface SalesforceSession {
  accessToken: string;
  instanceUrl: string;
}

export interface SalesforceObjectSummary {
  name: string;
  label: string;
  custom: boolean;
}

export interface SalesforceFieldSummary {
  name: string;
  label: string;
  salesforceType: string;
  dataType: PipelineDataType;
  nillable: boolean;
  queryable: boolean;
}

export interface SalesforceObjectDescription {
  name: string;
  label: string;
  fields: SalesforceFieldSummary[];
  modifiedField: string;
  supportsDeleted: boolean;
}

interface SalesforceError {
  errorCode?: string;
  message?: string;
}

function salesforceHost(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-GB");
  return normalized === "salesforce.com" || normalized.endsWith(".salesforce.com");
}

export function normalizeSalesforceDomain(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter the full Salesforce My Domain URL, including https://.");
  }
  if (
    parsed.protocol !== "https:" ||
    !salesforceHost(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Salesforce My Domain must be an HTTPS salesforce.com hostname without credentials or a custom port.");
  }
  return parsed.origin;
}

function assertIdentifier(value: string, label: string): string {
  if (!SALESFORCE_IDENTIFIER.test(value)) throw new Error(`Invalid Salesforce ${label}: ${value}.`);
  return value;
}

async function responseError(response: Response): Promise<string> {
  const fallback = `Salesforce request failed (HTTP ${response.status}).`;
  try {
    const payload = await response.json() as SalesforceError | SalesforceError[];
    const issue = Array.isArray(payload) ? payload[0] : payload;
    const detail = issue?.message || issue?.errorCode;
    return detail ? `Salesforce request failed: ${String(detail).slice(0, 400)}` : fallback;
  } catch {
    return fallback;
  }
}

async function salesforceFetch<T>(session: SalesforceSession, path: string, init?: RequestInit): Promise<T> {
  const target = new URL(path, session.instanceUrl);
  if (target.origin !== session.instanceUrl || !target.pathname.startsWith("/services/")) {
    throw new Error("Salesforce returned an invalid continuation URL.");
  }
  const response = await fetch(target, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
      ...init?.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

export async function authenticateSalesforce(credentials: SalesforceCredentials): Promise<SalesforceSession> {
  const myDomainUrl = normalizeSalesforceDomain(credentials.myDomainUrl);
  if (!credentials.clientId.trim() || !credentials.clientSecret.trim()) {
    throw new Error("Salesforce consumer key and consumer secret are required.");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId.trim(),
    client_secret: credentials.clientSecret.trim(),
  });
  const response = await fetch(`${myDomainUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const payload = await response.json() as { access_token?: string; instance_url?: string };
  if (!payload.access_token || !payload.instance_url) throw new Error("Salesforce authentication returned an incomplete token response.");
  const instanceUrl = normalizeSalesforceDomain(payload.instance_url);
  return { accessToken: payload.access_token, instanceUrl };
}

export async function resolveSalesforceApiVersion(
  session: SalesforceSession,
  requestedVersion?: string,
): Promise<string> {
  const versions = await salesforceFetch<Array<{ version?: string }>>(session, "/services/data/");
  const available = versions
    .map((entry) => entry.version)
    .filter((version): version is string => Boolean(version && API_VERSION.test(version)))
    .sort((left, right) => Number(right) - Number(left));
  if (requestedVersion) {
    if (!API_VERSION.test(requestedVersion) || !available.includes(requestedVersion)) {
      throw new Error(`Salesforce API version ${requestedVersion} is not available for this organisation.`);
    }
    return requestedVersion;
  }
  if (!available[0]) throw new Error("Salesforce did not return a supported REST API version.");
  return available[0];
}

export async function discoverSalesforceObjects(
  session: SalesforceSession,
  apiVersion: string,
): Promise<SalesforceObjectSummary[]> {
  if (!API_VERSION.test(apiVersion)) throw new Error("Invalid Salesforce API version.");
  const payload = await salesforceFetch<{ sobjects?: Array<Record<string, unknown>> }>(
    session,
    `/services/data/v${apiVersion}/sobjects/`,
  );
  return (payload.sobjects ?? [])
    .filter((object) => object.queryable === true && object.deprecatedAndHidden !== true)
    .map((object) => ({
      name: assertIdentifier(String(object.name ?? ""), "object name"),
      label: String(object.label ?? object.name ?? "Salesforce object").slice(0, 200),
      custom: object.custom === true,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "en-GB"));
}

export function salesforceTypeToPipelineType(type: string): PipelineDataType {
  if (["int", "long"].includes(type)) return "integer";
  if (["currency", "double", "percent"].includes(type)) return "numeric";
  if (type === "boolean") return "boolean";
  if (type === "date") return "date";
  if (type === "datetime") return "timestamp";
  return "string";
}

export async function describeSalesforceObject(
  session: SalesforceSession,
  apiVersion: string,
  objectName: string,
): Promise<SalesforceObjectDescription> {
  assertIdentifier(objectName, "object name");
  if (!API_VERSION.test(apiVersion)) throw new Error("Invalid Salesforce API version.");
  const payload = await salesforceFetch<Record<string, unknown>>(
    session,
    `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(objectName)}/describe`,
  );
  if (payload.queryable !== true) throw new Error(`${objectName} is not queryable by this Salesforce integration user.`);
  const fields = ((payload.fields as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((field) => field.name && field.queryable === true && !UNSUPPORTED_FIELD_TYPES.has(String(field.type).toLocaleLowerCase("en-GB")))
    .map((field) => ({
      name: assertIdentifier(String(field.name), "field name"),
      label: String(field.label ?? field.name).slice(0, 200),
      salesforceType: String(field.type ?? "string"),
      dataType: salesforceTypeToPipelineType(String(field.type ?? "string")),
      nillable: field.nillable === true,
      queryable: true,
    }));
  const names = new Set(fields.map((field) => field.name));
  if (!names.has("Id")) throw new Error(`${objectName} does not expose its Id to this integration user.`);
  const modifiedField = ["SystemModstamp", "LastModifiedDate", "CreatedDate"].find((name) => names.has(name));
  if (!modifiedField) throw new Error(`${objectName} does not expose a supported incremental watermark field.`);
  return {
    name: objectName,
    label: String(payload.label ?? objectName).slice(0, 200),
    fields,
    modifiedField,
    supportsDeleted: names.has("IsDeleted"),
  };
}

function soqlTimestamp(value: Date): string {
  if (Number.isNaN(value.valueOf())) throw new Error("Invalid Salesforce extraction timestamp.");
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function extractSalesforceRecords(input: {
  session: SalesforceSession;
  apiVersion: string;
  objectName: string;
  fields: string[];
  modifiedField: string;
  windowFrom: Date | null;
  windowTo: Date;
  includeDeleted: boolean;
}): Promise<Array<Record<string, string | number | boolean | null>>> {
  if (!API_VERSION.test(input.apiVersion)) throw new Error("Invalid Salesforce API version.");
  assertIdentifier(input.objectName, "object name");
  assertIdentifier(input.modifiedField, "watermark field");
  const fields = [...new Set(input.fields.map((field) => assertIdentifier(field, "field name")))];
  if (fields.length === 0 || fields.length > MAX_SELECTED_FIELDS) {
    throw new Error(`Select between 1 and ${MAX_SELECTED_FIELDS} Salesforce fields.`);
  }
  if (!fields.includes("Id") || !fields.includes(input.modifiedField)) {
    throw new Error("Salesforce extraction fields must include Id and the incremental watermark.");
  }
  if (Number.isNaN(input.windowTo.valueOf()) || (input.windowFrom && input.windowFrom >= input.windowTo)) {
    throw new Error("Salesforce extraction requires a valid increasing time window.");
  }
  const where = [
    input.windowFrom ? `${input.modifiedField} >= ${soqlTimestamp(input.windowFrom)}` : null,
    `${input.modifiedField} < ${soqlTimestamp(input.windowTo)}`,
  ].filter(Boolean).join(" AND ");
  const soql = `SELECT ${fields.join(", ")} FROM ${input.objectName} WHERE ${where} ORDER BY ${input.modifiedField} ASC, Id ASC`;
  const endpoint = input.includeDeleted ? "queryAll" : "query";
  let nextPath: string | null = `/services/data/v${input.apiVersion}/${endpoint}/?q=${encodeURIComponent(soql)}`;
  const records: Array<Record<string, string | number | boolean | null>> = [];

  while (nextPath) {
    const page: {
      records?: Array<Record<string, unknown>>;
      done?: boolean;
      nextRecordsUrl?: string;
    } = await salesforceFetch(input.session, nextPath, {
      headers: { "sforce-query-options": "batchSize=2000" },
    });
    for (const source of page.records ?? []) {
      const record: Record<string, string | number | boolean | null> = Object.create(null);
      for (const field of fields) {
        const value = source[field];
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          record[field] = value ?? null;
        } else {
          throw new Error(`Salesforce field ${field} returned a non-scalar value and cannot enter a governed tabular pipeline.`);
        }
      }
      records.push(record);
      if (records.length > MAX_REST_ROWS) {
        throw new Error(`This extraction exceeds ${MAX_REST_ROWS.toLocaleString("en-GB")} rows; configure a narrower bootstrap window while Bulk API support is added.`);
      }
    }
    if (page.done !== true && !page.nextRecordsUrl) {
      throw new Error("Salesforce returned an incomplete query continuation response.");
    }
    nextPath = page.done === true ? null : page.nextRecordsUrl ?? null;
    if (nextPath && (!nextPath.startsWith("/services/data/") || nextPath.includes("://"))) {
      throw new Error("Salesforce returned an invalid query continuation URL.");
    }
  }
  return records;
}
