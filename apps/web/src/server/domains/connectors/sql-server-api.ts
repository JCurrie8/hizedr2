import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as sql from "mssql";
import type { PipelineDataType } from "./tabular-load";

const IDENTIFIER_PATTERN = /^[\p{L}_][\p{L}\p{N}_@$# -]{0,127}$/u;
const MAX_EXTRACT_ROWS = 100_000;
export const MAX_SQL_ANALYSIS_ROWS = 5_000;
const SQL_ANALYSIS_COLUMNS = new Set([
  "org_node_id", "org_code", "series_key", "series_label", "category_label",
  "period_start", "period_end", "actual_value", "target_value", "prior_period_value",
  "numerator_value", "denominator_value", "source_refreshed_at",
]);
const SQL_ANALYSIS_REQUIRED_COLUMNS = [
  "series_key", "series_label", "period_start", "period_end", "actual_value",
] as const;

export interface SqlServerCredentials {
  server: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface SqlServerObjectSummary {
  schema: string;
  name: string;
  objectType: "table" | "view";
}

export interface SqlServerFieldSummary {
  name: string;
  sqlType: string;
  dataType: PipelineDataType;
  nullable: boolean;
  primaryKey: boolean;
  supported: boolean;
}

export interface SqlServerObjectDescription extends SqlServerObjectSummary {
  fields: SqlServerFieldSummary[];
}

export interface SqlAnalysisSourceRow {
  orgNodeId: string | null;
  orgCode: string | null;
  seriesKey: string;
  seriesLabel: string;
  categoryLabel: string;
  periodStart: string;
  periodEnd: string;
  actualValue: number;
  targetValue: number | null;
  priorPeriodValue: number | null;
  numeratorValue: number | null;
  denominatorValue: number | null;
  sourceRefreshedAt: string;
}

export interface SqlAnalysisExecution {
  rows: SqlAnalysisSourceRow[];
  signature: Array<{ name: string; sqlType: string }>;
}

function assertIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!IDENTIFIER_PATTERN.test(trimmed)) throw new Error(`${label} is not a valid SQL Server identifier.`);
  return trimmed;
}

export function quoteSqlServerIdentifier(value: string): string {
  const identifier = assertIdentifier(value, "Identifier");
  return `[${identifier.replaceAll("]", "]]")}]`;
}

export function normalizeSqlServerHost(value: string): string {
  const host = value.trim().toLocaleLowerCase("en-GB").replace(/^tcp:/, "").replace(/\.$/, "");
  if (!host || host.length > 253 || host.includes("/") || host.includes("\\") || host.includes(":")) {
    throw new Error("Enter a DNS host name without a protocol, instance name or port.");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1") {
    throw new Error("Hosted SQL connections cannot target the application host.");
  }
  const labels = host.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Enter a valid SQL Server DNS host name.");
  }
  return host;
}

export function isPublicSqlAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLocaleLowerCase("en-GB");
    if (normalized.startsWith("::ffff:")) return isPublicSqlAddress(normalized.slice(7));
    return !(
      normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

export async function assertPublicSqlHost(server: string): Promise<void> {
  const addresses = await lookup(normalizeSqlServerHost(server), { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicSqlAddress(address))) {
    throw new Error("Hosted SQL connections require a public DNS endpoint. Use the Hized gateway for private or on-premises databases.");
  }
}

export function sqlServerConnectionConfig(credentials: SqlServerCredentials, requestTimeout = 120_000): sql.config {
  return {
    server: normalizeSqlServerHost(credentials.server),
    port: credentials.port,
    database: credentials.database,
    user: credentials.username,
    password: credentials.password,
    connectionTimeout: 15_000,
    requestTimeout,
    pool: { min: 0, max: 2, idleTimeoutMillis: 15_000 },
    options: {
      appName: "Hized Connect",
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
    },
  };
}

async function withSqlServer<T>(credentials: SqlServerCredentials, work: (pool: sql.ConnectionPool) => Promise<T>, requestTimeout?: number): Promise<T> {
  await assertPublicSqlHost(credentials.server);
  const pool = new sql.ConnectionPool(sqlServerConnectionConfig(credentials, requestTimeout));
  try {
    await pool.connect();
    return await work(pool);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SQL Server rejected the connection.";
    throw new Error(`SQL Server connection failed: ${message.slice(0, 350)}`);
  } finally {
    await pool.close().catch(() => {});
  }
}

export async function testSqlServerConnection(credentials: SqlServerCredentials): Promise<{ database: string; serverVersion: string }> {
  return withSqlServer(credentials, async (pool) => {
    const result = await pool.request().query<{
      database_name: string;
      server_version: string;
      db_owner: number;
      data_writer: number;
      ddl_admin: number;
      security_admin: number;
      access_admin: number;
      control_database: number;
      writable_objects: number;
    }>(`
      select
        db_name() as database_name,
        cast(serverproperty('ProductVersion') as nvarchar(128)) as server_version,
        is_member('db_owner') as db_owner,
        is_member('db_datawriter') as data_writer,
        is_member('db_ddladmin') as ddl_admin,
        is_member('db_securityadmin') as security_admin,
        is_member('db_accessadmin') as access_admin,
        has_perms_by_name(db_name(), 'DATABASE', 'CONTROL') as control_database,
        (select count_big(*)
           from sys.objects o
          where o.type in ('U', 'V')
            and (
              has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'INSERT') = 1
              or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'UPDATE') = 1
              or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'DELETE') = 1
              or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'ALTER') = 1
              or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'CONTROL') = 1
            )) as writable_objects
    `);
    const row = result.recordset[0];
    if (!row) throw new Error("SQL Server returned no connection identity.");
    if (
      Number(row.db_owner) === 1
      || Number(row.data_writer) === 1
      || Number(row.ddl_admin) === 1
      || Number(row.security_admin) === 1
      || Number(row.access_admin) === 1
      || Number(row.control_database) === 1
      || Number(row.writable_objects) > 0
    ) {
      throw new Error("Use a dedicated read-only login; database administration and object write permissions are refused.");
    }
    return { database: row.database_name, serverVersion: row.server_version };
  });
}

export async function discoverSqlServerObjects(credentials: SqlServerCredentials): Promise<SqlServerObjectSummary[]> {
  return withSqlServer(credentials, async (pool) => {
    const result = await pool.request().query<{ schema_name: string; object_name: string; object_type: "table" | "view" }>(`
      select table_schema as schema_name, table_name as object_name,
             case when table_type = 'VIEW' then 'view' else 'table' end as object_type
        from information_schema.tables
       where table_schema not in ('sys', 'information_schema')
         and table_type in ('BASE TABLE', 'VIEW')
         and has_perms_by_name(quotename(table_schema) + '.' + quotename(table_name), 'OBJECT', 'SELECT') = 1
       order by table_schema, table_name
    `);
    return result.recordset.slice(0, 2_000).map((row) => ({
      schema: row.schema_name,
      name: row.object_name,
      objectType: row.object_type,
    }));
  });
}

function mapSqlType(sqlType: string): { dataType: PipelineDataType; supported: boolean } {
  const normalized = sqlType.toLocaleLowerCase("en-GB");
  if (["bigint", "int", "smallint", "tinyint"].includes(normalized)) return { dataType: "integer", supported: true };
  if (["decimal", "numeric", "money", "smallmoney", "float", "real"].includes(normalized)) return { dataType: "numeric", supported: true };
  if (normalized === "bit") return { dataType: "boolean", supported: true };
  if (normalized === "date") return { dataType: "date", supported: true };
  if (["datetime", "datetime2", "datetimeoffset", "smalldatetime"].includes(normalized)) return { dataType: "timestamp", supported: true };
  if (["char", "nchar", "varchar", "nvarchar", "text", "ntext", "uniqueidentifier", "xml"].includes(normalized)) {
    return { dataType: "string", supported: true };
  }
  return { dataType: "string", supported: false };
}

export async function describeSqlServerObject(
  credentials: SqlServerCredentials,
  input: { schema: string; object: string },
): Promise<SqlServerObjectDescription> {
  const schema = assertIdentifier(input.schema, "Schema");
  const object = assertIdentifier(input.object, "Table or view");
  return withSqlServer(credentials, async (pool) => {
    const request = pool.request()
      .input("schema", sql.NVarChar(128), schema)
      .input("object", sql.NVarChar(128), object);
    const result = await request.query<{
      object_type: "table" | "view";
      column_name: string;
      data_type: string;
      nullable: "YES" | "NO";
      primary_key: boolean;
    }>(`
      select case when t.table_type = 'VIEW' then 'view' else 'table' end as object_type,
             c.column_name, c.data_type, c.is_nullable as nullable,
             cast(case when pk.column_name is null then 0 else 1 end as bit) as primary_key
        from information_schema.tables t
        join information_schema.columns c
          on c.table_schema = t.table_schema and c.table_name = t.table_name
        left join (
          select ku.table_schema, ku.table_name, ku.column_name
            from information_schema.table_constraints tc
            join information_schema.key_column_usage ku
              on ku.constraint_schema = tc.constraint_schema
             and ku.constraint_name = tc.constraint_name
           where tc.constraint_type = 'PRIMARY KEY'
        ) pk on pk.table_schema = c.table_schema
            and pk.table_name = c.table_name and pk.column_name = c.column_name
       where t.table_schema = @schema and t.table_name = @object
       order by c.ordinal_position
    `);
    if (result.recordset.length === 0) throw new Error("The table or view was not found or is not visible to this login.");
    return {
      schema,
      name: object,
      objectType: result.recordset[0].object_type,
      fields: result.recordset.map((row) => ({
        name: row.column_name,
        sqlType: row.data_type,
        nullable: row.nullable === "YES",
        primaryKey: row.primary_key === true,
        ...mapSqlType(row.data_type),
      })),
    };
  });
}

function scalarValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  throw new Error("SQL Server returned an unsupported nested or binary value.");
}

function analysisSqlForInspection(sqlText: string): string {
  return sqlText
    .replace(/N?'(?:''|[^'])*'/gi, "''")
    .replace(/\[[^\]]*(?:\]\][^\]]*)*\]/g, "[]")
    .replace(/"(?:""|[^"])*"/g, '""');
}

export function validateSqlAnalysisText(sqlText: string): string {
  const normalized = sqlText.trim().replace(/;\s*$/, "").trim();
  if (normalized.length < 8 || normalized.length > 50_000) {
    throw new Error("SQL analysis must be between 8 and 50,000 characters.");
  }
  if (/--|\/\*/.test(normalized)) throw new Error("SQL analysis comments are not supported.");
  const inspected = analysisSqlForInspection(normalized);
  if (inspected.includes(";")) throw new Error("SQL analysis must contain one statement only.");
  if (!/^\s*(select\b|with\b)/i.test(inspected)) throw new Error("SQL analysis must be a SELECT or CTE query.");
  const refused = /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|deny|execute|exec|declare|set|use|dbcc|backup|restore|kill|waitfor|openrowset|openquery|opendatasource|bulk)\b/i.exec(inspected);
  if (refused) throw new Error(`SQL analysis cannot use ${refused[1].toUpperCase()}.`);
  if (/\bselect\b[\s\S]*?\binto\b/i.test(inspected)) throw new Error("SQL analysis cannot use SELECT INTO.");
  return normalized;
}

function requiredAnalysisText(row: Record<string, unknown>, key: string, max: number): string {
  const value = String(row[key] ?? "").trim();
  if (!value || value.length > max) throw new Error(`${key} must be present and ${max} characters or fewer.`);
  return value;
}

function nullableAnalysisNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`${key} must be numeric.`);
  return numeric;
}

function analysisDate(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new Error(`${key} must be a valid date.`);
  return date.toISOString().slice(0, 10);
}

function analysisTimestamp(row: Record<string, unknown>): string {
  const value = row.source_refreshed_at;
  if (value === null || value === undefined || value === "") return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("source_refreshed_at must be a valid timestamp.");
  return date.toISOString();
}

export async function executeSqlAnalysisQuery(
  credentials: SqlServerCredentials,
  sqlText: string,
  maxRows = MAX_SQL_ANALYSIS_ROWS,
): Promise<SqlAnalysisExecution> {
  const query = validateSqlAnalysisText(sqlText);
  const boundedRows = Math.min(Math.max(maxRows, 1), MAX_SQL_ANALYSIS_ROWS);
  return withSqlServer(credentials, async (pool) => {
    const request = pool.request();
    const result = await request.query<Record<string, unknown>>(`set rowcount ${boundedRows + 1}; ${query}`);
    if (result.recordsets.length !== 1) throw new Error("SQL analysis must return exactly one result set.");
    if (result.recordset.length > boundedRows) {
      throw new Error(`SQL analysis exceeds ${boundedRows.toLocaleString("en-GB")} rows; aggregate or filter it further.`);
    }
    const names = Object.keys(result.recordset.columns ?? {}).map((name) => name.toLocaleLowerCase("en-GB"));
    if (new Set(names).size !== names.length) throw new Error("SQL analysis column aliases must be unique.");
    const unexpected = names.filter((name) => !SQL_ANALYSIS_COLUMNS.has(name));
    if (unexpected.length > 0) throw new Error(`Unsupported SQL analysis columns: ${unexpected.join(", ")}.`);
    const missing = SQL_ANALYSIS_REQUIRED_COLUMNS.filter((name) => !names.includes(name));
    if (missing.length > 0) throw new Error(`SQL analysis is missing required columns: ${missing.join(", ")}.`);
    if (!names.includes("org_node_id") && !names.includes("org_code")) {
      throw new Error("SQL analysis must return org_node_id or org_code for permission-safe results.");
    }
    const rows = result.recordset.map((sourceRow) => {
      const row = Object.fromEntries(Object.entries(sourceRow).map(([key, value]) => [key.toLocaleLowerCase("en-GB"), value]));
      const actualValue = nullableAnalysisNumber(row, "actual_value");
      if (actualValue === null) throw new Error("actual_value cannot be null.");
      const periodStart = analysisDate(row, "period_start");
      const periodEnd = analysisDate(row, "period_end");
      if (periodEnd <= periodStart) throw new Error("period_end must be later than period_start.");
      const seriesKey = requiredAnalysisText(row, "series_key", 80);
      if (!/^[a-z][a-z0-9_]*$/.test(seriesKey)) throw new Error("series_key must use lowercase letters, numbers and underscores.");
      const numeratorValue = nullableAnalysisNumber(row, "numerator_value");
      const denominatorValue = nullableAnalysisNumber(row, "denominator_value");
      if ((numeratorValue === null) !== (denominatorValue === null) || denominatorValue === 0) {
        throw new Error("numerator_value and non-zero denominator_value must be returned together.");
      }
      return {
        orgNodeId: row.org_node_id === null || row.org_node_id === undefined ? null : String(row.org_node_id).trim(),
        orgCode: row.org_code === null || row.org_code === undefined ? null : String(row.org_code).trim(),
        seriesKey,
        seriesLabel: requiredAnalysisText(row, "series_label", 120),
        categoryLabel: row.category_label === null || row.category_label === undefined ? "" : String(row.category_label).trim().slice(0, 160),
        periodStart,
        periodEnd,
        actualValue,
        targetValue: nullableAnalysisNumber(row, "target_value"),
        priorPeriodValue: nullableAnalysisNumber(row, "prior_period_value"),
        numeratorValue,
        denominatorValue,
        sourceRefreshedAt: analysisTimestamp(row),
      } satisfies SqlAnalysisSourceRow;
    });
    const signature = Object.entries(result.recordset.columns ?? {}).map(([name, column]) => ({
      name: name.toLocaleLowerCase("en-GB"),
      sqlType: typeof column.type === "function" ? (column.type.name || "scalar") : "scalar",
    }));
    return { rows, signature };
  }, 30_000);
}

export async function extractSqlServerRows(
  credentials: SqlServerCredentials,
  input: {
    schema: string;
    object: string;
    fields: string[];
    orderFields: string[];
    watermarkField: string | null;
    windowFrom: Date | null;
    windowTo: Date;
    maxRows?: number;
  },
): Promise<Record<string, string | number | boolean | null>[]> {
  const schema = quoteSqlServerIdentifier(input.schema);
  const object = quoteSqlServerIdentifier(input.object);
  const fields = [...new Set(input.fields)].map(quoteSqlServerIdentifier);
  if (fields.length === 0 || fields.length > 250) throw new Error("Select between 1 and 250 SQL Server fields.");
  const maxRows = Math.min(Math.max(input.maxRows ?? MAX_EXTRACT_ROWS, 1), MAX_EXTRACT_ROWS);
  const orderFields = [...new Set(input.orderFields)].map(quoteSqlServerIdentifier);
  const watermark = input.watermarkField ? quoteSqlServerIdentifier(input.watermarkField) : null;
  const where = watermark && input.windowFrom
    ? `where ${watermark} >= @windowFrom and ${watermark} < @windowTo`
    : watermark
      ? `where ${watermark} < @windowTo`
      : "";
  const order = orderFields.length > 0 ? `order by ${orderFields.join(", ")}` : "";

  return withSqlServer(credentials, async (pool) => {
    const request = pool.request();
    if (watermark) {
      request.input("windowTo", sql.DateTime2, input.windowTo);
      if (input.windowFrom) request.input("windowFrom", sql.DateTime2, input.windowFrom);
    }
    const result = await request.query<Record<string, unknown>>(
      `select top (${maxRows + 1}) ${fields.join(", ")} from ${schema}.${object} ${where} ${order}`,
    );
    if (result.recordset.length > maxRows) {
      throw new Error(`The extract exceeds ${maxRows.toLocaleString("en-GB")} rows; add a watermark or narrow the source.`);
    }
    return result.recordset.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, scalarValue(value)]),
    ));
  });
}
