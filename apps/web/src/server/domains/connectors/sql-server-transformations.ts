import type { PoolClient } from "@neondatabase/serverless";
import type { SqlServerObjectDescription } from "./sql-server-api";
import type { PipelineDataType } from "./tabular-load";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface SqlTransformationColumnSignature {
  name: string;
  sqlType: string;
  dataType: PipelineDataType;
  nullable: boolean;
  primaryKey: boolean;
}

export interface PipelineSqlTransformationVersion {
  id: string;
  destinationId: string;
  versionNumber: number;
  objectSchema: string;
  objectName: string;
  objectType: "table" | "view";
  columnSignature: SqlTransformationColumnSignature[];
  status: "draft" | "approved" | "superseded";
  changeNote: string;
  validatedAt: string;
  createdAt: string;
  createdBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

function validateSignature(signature: SqlTransformationColumnSignature[]): SqlTransformationColumnSignature[] {
  if (signature.length < 1 || signature.length > 250) {
    throw new Error("The transformed SQL object must expose between 1 and 250 supported fields.");
  }
  const names = new Set<string>();
  return signature.map((field) => {
    const name = field.name.trim();
    const sqlType = field.sqlType.trim().toLocaleLowerCase("en-GB");
    const key = name.toLocaleLowerCase("en-GB");
    if (!name || name.length > 128 || !sqlType || sqlType.length > 128 || names.has(key)) {
      throw new Error("The transformed SQL object contains invalid or duplicate fields.");
    }
    names.add(key);
    return {
      name,
      sqlType,
      dataType: field.dataType,
      nullable: field.nullable,
      primaryKey: field.primaryKey,
    };
  });
}

export function sqlTransformationColumnSignature(
  description: SqlServerObjectDescription,
): SqlTransformationColumnSignature[] {
  if (description.fields.some((field) => !field.supported)) {
    throw new Error("The transformed SQL object contains field types that Hized cannot publish yet.");
  }
  return validateSignature(description.fields.map((field) => ({
    name: field.name,
    sqlType: field.sqlType,
    dataType: field.dataType,
    nullable: field.nullable,
    primaryKey: field.primaryKey,
  })));
}

export function sqlTransformationSignaturesMatch(
  left: SqlTransformationColumnSignature[],
  right: SqlTransformationColumnSignature[],
): boolean {
  return JSON.stringify(validateSignature(left)) === JSON.stringify(validateSignature(right));
}

function fromRow(row: Record<string, unknown>): PipelineSqlTransformationVersion {
  return {
    id: String(row.id),
    destinationId: String(row.destination_id),
    versionNumber: Number(row.version_number),
    objectSchema: String(row.object_schema),
    objectName: String(row.object_name),
    objectType: row.object_type as "table" | "view",
    columnSignature: row.column_signature as SqlTransformationColumnSignature[],
    status: row.status as "draft" | "approved" | "superseded",
    changeNote: String(row.change_note),
    validatedAt: new Date(String(row.validated_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
  };
}

const SELECT_COLUMNS = `
  transformation.id, transformation.destination_id, transformation.version_number,
  transformation.object_schema, transformation.object_name, transformation.object_type,
  transformation.column_signature, transformation.status, transformation.change_note,
  transformation.validated_at, transformation.created_at, transformation.created_by,
  transformation.approved_at, transformation.approved_by`;

export async function listPipelineSqlTransformationVersions(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string },
): Promise<PipelineSqlTransformationVersion[]> {
  const { rows } = await client.query(
    `select ${SELECT_COLUMNS}
       from public.pipeline_sql_transformation_versions transformation
       join public.pipeline_sql_destinations destination
         on destination.id = transformation.destination_id
        and destination.tenant_id = transformation.tenant_id
      where transformation.tenant_id = $1 and destination.pipeline_id = $2
      order by transformation.version_number desc`,
    [input.tenantId, input.pipelineId],
  );
  return rows.map(fromRow);
}

export async function getPipelineSqlTransformationVersion(
  client: PoolClient,
  input: { tenantId: string; pipelineId: string; transformationId: string },
): Promise<PipelineSqlTransformationVersion> {
  const { rows: [row] } = await client.query(
    `select ${SELECT_COLUMNS}
       from public.pipeline_sql_transformation_versions transformation
       join public.pipeline_sql_destinations destination
         on destination.id = transformation.destination_id
        and destination.tenant_id = transformation.tenant_id
      where transformation.id = $1 and transformation.tenant_id = $2
        and destination.pipeline_id = $3`,
    [input.transformationId, input.tenantId, input.pipelineId],
  );
  if (!row) throw new Error("The SQL transformation version was not found in this pipeline.");
  return fromRow(row);
}

export async function registerSqlTransformationVersion(
  client: PoolClient,
  input: {
    tenantId: string;
    destinationId: string;
    actorUserId: string;
    description: SqlServerObjectDescription;
    changeNote: string;
  },
): Promise<{ id: string; versionNumber: number }> {
  const changeNote = input.changeNote.trim();
  if (!IDENTIFIER_PATTERN.test(input.description.schema) || !IDENTIFIER_PATTERN.test(input.description.name)) {
    throw new Error("The transformed SQL schema and object names must use letters, numbers and underscores.");
  }
  if (changeNote.length < 1 || changeNote.length > 500) {
    throw new Error("Explain this transformation version in 1 to 500 characters.");
  }
  const signature = sqlTransformationColumnSignature(input.description);
  const { rows: [row] } = await client.query(
    `select * from public.create_sql_transformation_version($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      input.tenantId,
      input.destinationId,
      input.description.schema,
      input.description.name,
      input.description.objectType,
      JSON.stringify(signature),
      changeNote,
      input.actorUserId,
    ],
  );
  if (!row) throw new Error("The SQL transformation version could not be registered.");
  return { id: row.id, versionNumber: Number(row.version_number) };
}

export async function approveSqlTransformationVersion(
  client: PoolClient,
  input: { tenantId: string; transformationId: string; actorUserId: string },
): Promise<{ id: string; destinationId: string; versionNumber: number }> {
  const { rows: [row] } = await client.query(
    `select * from public.approve_sql_transformation_version($1, $2, $3)`,
    [input.tenantId, input.transformationId, input.actorUserId],
  );
  if (!row) throw new Error("The SQL transformation version could not be approved.");
  return { id: row.id, destinationId: row.destination_id, versionNumber: Number(row.version_number) };
}
