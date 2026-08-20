import { createHash } from "node:crypto";
import * as sql from "mssql";
import type { PipelineDataType } from "./tabular-load";
import {
  assertPublicSqlHost,
  quoteSqlServerIdentifier,
  sqlServerConnectionConfig,
  type SqlServerCredentials,
} from "./sql-server-api";

const MANAGED_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_DESTINATION_ROWS = 100_000;

export interface SqlDestinationField {
  sourceField: string;
  targetColumn: string;
  dataType: PipelineDataType;
}

export interface SqlDestinationRecord {
  recordKey: string;
  sourceRunId: string;
  data: Record<string, string | number | boolean | null>;
}

function assertManagedName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!MANAGED_NAME_PATTERN.test(trimmed)) {
    throw new Error(`${label} must start with a letter or underscore and contain only letters, numbers and underscores.`);
  }
  return trimmed;
}

export function normalizeDestinationColumnName(value: string, used: Set<string>): string {
  const normalized = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = (/^[A-Za-z_]/.test(normalized) ? normalized : `field_${normalized || "value"}`).slice(0, 112);
  let candidate = stem || "field_value";
  if (used.has(candidate.toLocaleLowerCase("en-GB"))) {
    const suffix = createHash("sha256").update(value).digest("hex").slice(0, 10);
    candidate = `${stem.slice(0, 101)}_${suffix}`;
  }
  let counter = 2;
  while (used.has(candidate.toLocaleLowerCase("en-GB"))) {
    candidate = `${stem.slice(0, 106)}_${counter}`;
    counter += 1;
  }
  used.add(candidate.toLocaleLowerCase("en-GB"));
  return candidate;
}

function sqlTypeDefinition(dataType: PipelineDataType): string {
  if (dataType === "integer") return "bigint";
  if (dataType === "numeric") return "float";
  if (dataType === "boolean") return "bit";
  if (dataType === "date") return "date";
  if (dataType === "timestamp") return "datetime2(7)";
  return "nvarchar(max)";
}

function bulkType(dataType: PipelineDataType) {
  if (dataType === "integer") return sql.BigInt;
  if (dataType === "numeric") return sql.Float;
  if (dataType === "boolean") return sql.Bit;
  if (dataType === "date") return sql.Date;
  if (dataType === "timestamp") return sql.DateTime2(7);
  return sql.NVarChar(sql.MAX);
}

function destinationValue(value: unknown, dataType: PipelineDataType): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (dataType === "string") return String(value);
  if (dataType === "boolean") return typeof value === "boolean" ? value : String(value).toLocaleLowerCase("en-GB") === "true";
  if (dataType === "integer" || dataType === "numeric") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || (dataType === "integer" && !Number.isSafeInteger(number))) {
      throw new Error("A governed numeric value could not be written to SQL Server without loss.");
    }
    return number;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new Error("A governed date value could not be written to SQL Server.");
  return date;
}

async function withSqlDestination<T>(
  credentials: SqlServerCredentials,
  work: (pool: sql.ConnectionPool) => Promise<T>,
): Promise<T> {
  await assertPublicSqlHost(credentials.server);
  const pool = new sql.ConnectionPool(sqlServerConnectionConfig(credentials));
  try {
    await pool.connect();
    return await work(pool);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SQL Server rejected the destination operation.";
    throw new Error(`SQL destination failed: ${message.slice(0, 350)}`);
  } finally {
    await pool.close().catch(() => {});
  }
}

async function assertDestinationPermissions(pool: sql.ConnectionPool, managedSchema: string) {
  const schema = assertManagedName(managedSchema, "Managed schema");
  const result = await pool.request().input("schema", sql.NVarChar(128), schema).query<{
    database_name: string;
    server_version: string;
    schema_id: number | null;
    db_owner: number;
    data_writer: number;
    ddl_admin: number;
    security_admin: number;
    access_admin: number;
    control_database: number;
    alter_any_schema: number;
    create_table: number;
    schema_alter: number;
    schema_select: number;
    schema_insert: number;
    schema_update: number;
    schema_delete: number;
    outside_schema_admin: number;
    outside_object_writes: number;
  }>(`
    select db_name() as database_name,
           cast(serverproperty('ProductVersion') as nvarchar(128)) as server_version,
           schema_id(@schema) as schema_id,
           is_member('db_owner') as db_owner,
           is_member('db_datawriter') as data_writer,
           is_member('db_ddladmin') as ddl_admin,
           is_member('db_securityadmin') as security_admin,
           is_member('db_accessadmin') as access_admin,
           has_perms_by_name(db_name(), 'DATABASE', 'CONTROL') as control_database,
           has_perms_by_name(db_name(), 'DATABASE', 'ALTER ANY SCHEMA') as alter_any_schema,
           has_perms_by_name(db_name(), 'DATABASE', 'CREATE TABLE') as create_table,
           has_perms_by_name(@schema, 'SCHEMA', 'ALTER') as schema_alter,
           has_perms_by_name(@schema, 'SCHEMA', 'SELECT') as schema_select,
           has_perms_by_name(@schema, 'SCHEMA', 'INSERT') as schema_insert,
           has_perms_by_name(@schema, 'SCHEMA', 'UPDATE') as schema_update,
           has_perms_by_name(@schema, 'SCHEMA', 'DELETE') as schema_delete,
           (select count_big(*) from sys.schemas s
             where s.name <> @schema and s.name not in ('sys', 'information_schema')
               and (has_perms_by_name(s.name, 'SCHEMA', 'ALTER') = 1
                 or has_perms_by_name(s.name, 'SCHEMA', 'CONTROL') = 1)) as outside_schema_admin,
           (select count_big(*) from sys.objects o
             where schema_name(o.schema_id) <> @schema and o.type in ('U', 'V')
               and (has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'INSERT') = 1
                 or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'UPDATE') = 1
                 or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'DELETE') = 1
                 or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'ALTER') = 1
                 or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'CONTROL') = 1)) as outside_object_writes
  `);
  const row = result.recordset[0];
  if (!row || row.schema_id === null) throw new Error("The managed SQL schema does not exist or is not visible to this login.");
  if (
    Number(row.db_owner) === 1
    || Number(row.data_writer) === 1
    || Number(row.ddl_admin) === 1
    || Number(row.security_admin) === 1
    || Number(row.access_admin) === 1
    || Number(row.control_database) === 1
    || Number(row.alter_any_schema) === 1
    || Number(row.outside_schema_admin) > 0
    || Number(row.outside_object_writes) > 0
  ) {
    throw new Error("Use a dedicated loader that can write only inside the configured Hized schema; broad or outside-schema access is refused.");
  }
  if (
    Number(row.create_table) !== 1
    || Number(row.schema_alter) !== 1
    || Number(row.schema_select) !== 1
    || Number(row.schema_insert) !== 1
    || Number(row.schema_update) !== 1
    || Number(row.schema_delete) !== 1
  ) {
    throw new Error("The loader needs CREATE TABLE plus SELECT, INSERT, UPDATE, DELETE and ALTER on the configured Hized schema only.");
  }
  return { database: row.database_name, serverVersion: row.server_version, managedSchema: schema };
}

export async function testSqlServerDestination(
  credentials: SqlServerCredentials,
  managedSchema: string,
): Promise<{ database: string; serverVersion: string; managedSchema: string }> {
  return withSqlDestination(credentials, (pool) => assertDestinationPermissions(pool, managedSchema));
}

export async function replaceSqlServerDestinationSnapshot(
  credentials: SqlServerCredentials,
  input: {
    managedSchema: string;
    targetTable: string;
    pipelineId: string;
    sourceRunId: string;
    fields: SqlDestinationField[];
    records: SqlDestinationRecord[];
  },
): Promise<{ rowsWritten: number }> {
  const schema = assertManagedName(input.managedSchema, "Managed schema");
  const target = assertManagedName(input.targetTable, "Target table");
  if (input.fields.length === 0 || input.fields.length > 250) throw new Error("Select between 1 and 250 destination fields.");
  if (input.records.length === 0) throw new Error("An empty dataset cannot replace the SQL workbench target.");
  if (input.records.length > MAX_DESTINATION_ROWS) throw new Error(`The SQL workbench load exceeds ${MAX_DESTINATION_ROWS.toLocaleString("en-GB")} rows.`);
  const targetColumns = new Set<string>();
  for (const field of input.fields) {
    assertManagedName(field.targetColumn, "Destination column");
    const folded = field.targetColumn.toLocaleLowerCase("en-GB");
    if (targetColumns.has(folded)) throw new Error(`The destination column '${field.targetColumn}' is duplicated.`);
    targetColumns.add(folded);
  }
  const qualified = `${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(target)}`;
  const expectedColumns = [
    { name: "_hized_record_key", type: "nvarchar" },
    { name: "_hized_pipeline_id", type: "uniqueidentifier" },
    { name: "_hized_source_run_id", type: "uniqueidentifier" },
    { name: "_hized_loaded_at", type: "datetime2" },
    ...input.fields.map((field) => ({ name: field.targetColumn, type: sqlTypeDefinition(field.dataType).split("(")[0] })),
  ];
  const ddl = `create table ${qualified} (
    [_hized_record_key] nvarchar(256) not null primary key,
    [_hized_pipeline_id] uniqueidentifier not null,
    [_hized_source_run_id] uniqueidentifier not null,
    [_hized_loaded_at] datetime2(7) not null,
    ${input.fields.map((field) => `${quoteSqlServerIdentifier(field.targetColumn)} ${sqlTypeDefinition(field.dataType)} null`).join(",\n    ")}
  )`;

  return withSqlDestination(credentials, async (pool) => {
    await assertDestinationPermissions(pool, schema);
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const identity = await new sql.Request(transaction)
        .input("schema", sql.NVarChar(128), schema)
        .input("table", sql.NVarChar(128), target)
        .query<{ object_id: number | null; pipeline_id: string | null }>(`
          select object_id(quotename(@schema) + '.' + quotename(@table), 'U') as object_id,
                 cast((select value from sys.fn_listextendedproperty(
                   N'HizedPipelineId', N'SCHEMA', @schema, N'TABLE', @table, default, default
                 )) as nvarchar(128)) as pipeline_id
        `);
      const existing = identity.recordset[0];
      if (!existing?.object_id) {
        await new sql.Request(transaction).query(ddl);
        await new sql.Request(transaction)
          .input("schema", sql.NVarChar(128), schema)
          .input("table", sql.NVarChar(128), target)
          .input("pipelineId", sql.NVarChar(128), input.pipelineId)
          .query(`exec sys.sp_addextendedproperty
            @name=N'HizedPipelineId', @value=@pipelineId,
            @level0type=N'SCHEMA', @level0name=@schema,
            @level1type=N'TABLE', @level1name=@table`);
      } else {
        if (existing.pipeline_id !== input.pipelineId) {
          throw new Error("The target table is not owned by this Hized pipeline; no data was changed.");
        }
        const columns = await new sql.Request(transaction)
          .input("schema", sql.NVarChar(128), schema)
          .input("table", sql.NVarChar(128), target)
          .query<{ column_name: string; data_type: string }>(`
            select c.name as column_name, t.name as data_type
              from sys.columns c
              join sys.types t on t.user_type_id = c.user_type_id
              join sys.tables tb on tb.object_id = c.object_id
              join sys.schemas s on s.schema_id = tb.schema_id
             where s.name = @schema and tb.name = @table
             order by c.column_id
          `);
        const actual = columns.recordset.map((column) => `${column.column_name.toLocaleLowerCase("en-GB")}:${column.data_type.toLocaleLowerCase("en-GB")}`);
        const expected = expectedColumns.map((column) => `${column.name.toLocaleLowerCase("en-GB")}:${column.type}`);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("The SQL destination schema has drifted; the previous target was preserved for review.");
        }
      }

      await new sql.Request(transaction).query(`delete from ${qualified}`);
      const bulk = new sql.Table(`${schema}.${target}`);
      bulk.create = false;
      bulk.columns.add("_hized_record_key", sql.NVarChar(256), { nullable: false, primary: true });
      bulk.columns.add("_hized_pipeline_id", sql.UniqueIdentifier, { nullable: false });
      bulk.columns.add("_hized_source_run_id", sql.UniqueIdentifier, { nullable: false });
      bulk.columns.add("_hized_loaded_at", sql.DateTime2(7), { nullable: false });
      for (const field of input.fields) bulk.columns.add(field.targetColumn, bulkType(field.dataType), { nullable: true });
      const loadedAt = new Date();
      for (const record of input.records) {
        if (record.recordKey.length > 256) throw new Error("A governed record key exceeds the SQL destination limit.");
        bulk.rows.add(
          record.recordKey,
          input.pipelineId,
          record.sourceRunId,
          loadedAt,
          ...input.fields.map((field) => destinationValue(record.data[field.sourceField], field.dataType)),
        );
      }
      await new sql.Request(transaction).bulk(bulk);
      await transaction.commit();
      return { rowsWritten: input.records.length };
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    }
  });
}
