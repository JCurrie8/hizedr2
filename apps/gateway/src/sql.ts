import {
  MAX_SQL_ANALYSIS_ROWS,
  normalizeSqlAnalysisExecution,
  validateSqlAnalysisText,
  type SqlAnalysisExecution,
} from "@hized/contracts";
import * as sql from "mssql";
import type { GatewayConfig, GatewaySecrets } from "./config";

function connectionConfig(config: GatewayConfig, secrets: GatewaySecrets, requestTimeout = 30_000): sql.config {
  return {
    server: config.server,
    port: config.port,
    database: config.database,
    user: secrets.sqlUsername,
    password: secrets.sqlPassword,
    connectionTimeout: 15_000,
    requestTimeout,
    pool: { min: 0, max: 1, idleTimeoutMillis: 10_000 },
    options: {
      appName: "Hized Private Gateway",
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      enableArithAbort: true,
    },
  };
}

async function withLocalSql<T>(
  config: GatewayConfig,
  secrets: GatewaySecrets,
  work: (pool: sql.ConnectionPool) => Promise<T>,
  requestTimeout = 30_000,
): Promise<T> {
  const pool = new sql.ConnectionPool(connectionConfig(config, secrets, requestTimeout));
  try {
    await pool.connect();
    return await work(pool);
  } finally {
    await pool.close().catch(() => {});
  }
}

export async function inspectLocalSqlProfile(config: GatewayConfig, secrets: GatewaySecrets) {
  return withLocalSql(config, secrets, async (pool) => {
    const identity = await pool.request().query<{
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
      select db_name() as database_name,
             cast(serverproperty('ProductVersion') as nvarchar(128)) as server_version,
             is_member('db_owner') as db_owner,
             is_member('db_datawriter') as data_writer,
             is_member('db_ddladmin') as ddl_admin,
             is_member('db_securityadmin') as security_admin,
             is_member('db_accessadmin') as access_admin,
             has_perms_by_name(db_name(), 'DATABASE', 'CONTROL') as control_database,
             (select count_big(*) from sys.objects object
               where object.type in ('U', 'V') and (
                 has_perms_by_name(quotename(schema_name(object.schema_id)) + '.' + quotename(object.name), 'OBJECT', 'INSERT') = 1
                 or has_perms_by_name(quotename(schema_name(object.schema_id)) + '.' + quotename(object.name), 'OBJECT', 'UPDATE') = 1
                 or has_perms_by_name(quotename(schema_name(object.schema_id)) + '.' + quotename(object.name), 'OBJECT', 'DELETE') = 1
                 or has_perms_by_name(quotename(schema_name(object.schema_id)) + '.' + quotename(object.name), 'OBJECT', 'ALTER') = 1
                 or has_perms_by_name(quotename(schema_name(object.schema_id)) + '.' + quotename(object.name), 'OBJECT', 'CONTROL') = 1
               )) as writable_objects
    `);
    const row = identity.recordset[0];
    if (!row) throw new Error("SQL Server returned no connection identity.");
    if ([row.db_owner, row.data_writer, row.ddl_admin, row.security_admin, row.access_admin, row.control_database].some((value) => Number(value) === 1) || Number(row.writable_objects) > 0) {
      throw new Error("The gateway refuses this SQL identity because it has database administration or object write permissions.");
    }
    const catalog = await pool.request().query<{ schema_name: string; object_name: string; object_type: "table" | "view" }>(`
      select top (2000) table_schema as schema_name, table_name as object_name,
             case when table_type = 'VIEW' then 'view' else 'table' end as object_type
        from information_schema.tables
       where table_schema not in ('sys', 'information_schema')
         and table_type in ('BASE TABLE', 'VIEW')
         and has_perms_by_name(quotename(table_schema) + '.' + quotename(table_name), 'OBJECT', 'SELECT') = 1
       order by table_schema, table_name
    `);
    return {
      serverVersion: String(row.server_version),
      database: String(row.database_name),
      catalog: catalog.recordset.map((item) => ({
        schema: item.schema_name,
        name: item.object_name,
        objectType: item.object_type,
      })),
    };
  });
}

export async function executeLocalSqlAnalysis(
  config: GatewayConfig,
  secrets: GatewaySecrets,
  sqlText: string,
  maxRows: number,
): Promise<SqlAnalysisExecution> {
  const query = validateSqlAnalysisText(sqlText);
  const boundedRows = Math.min(Math.max(Math.trunc(maxRows), 1), MAX_SQL_ANALYSIS_ROWS);
  return withLocalSql(config, secrets, async (pool) => {
    const result = await pool.request().query<Record<string, unknown>>(`set rowcount ${boundedRows + 1}; ${query}`);
    if (result.recordsets.length !== 1) throw new Error("SQL analysis must return exactly one result set.");
    if (result.recordset.length > boundedRows) throw new Error(`SQL analysis exceeds ${boundedRows.toLocaleString("en-GB")} rows; aggregate or filter it further.`);
    const signature = Object.entries(result.recordset.columns ?? {}).map(([name, column]) => ({
      name: name.toLocaleLowerCase("en-GB"),
      sqlType: typeof column.type === "function" ? (column.type.name || "scalar") : "scalar",
    }));
    return normalizeSqlAnalysisExecution(result.recordset, signature);
  });
}
