import { z } from "zod";

export const MAX_SQL_ANALYSIS_ROWS = 5_000;

export const SQL_ANALYSIS_COLUMNS = [
  "org_node_id", "org_code", "series_key", "series_label", "category_label",
  "period_start", "period_end", "actual_value", "target_value", "prior_period_value",
  "numerator_value", "denominator_value", "source_refreshed_at",
] as const;

const SQL_ANALYSIS_COLUMN_SET = new Set<string>(SQL_ANALYSIS_COLUMNS);
const SQL_ANALYSIS_REQUIRED_COLUMNS = [
  "series_key", "series_label", "period_start", "period_end", "actual_value",
] as const;

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

export const sqlAnalysisExecutionSchema = z.object({
  rows: z.array(z.object({
    orgNodeId: z.string().uuid().nullable(),
    orgCode: z.string().max(160).nullable(),
    seriesKey: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
    seriesLabel: z.string().min(1).max(120),
    categoryLabel: z.string().max(160),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    actualValue: z.number().finite(),
    targetValue: z.number().finite().nullable(),
    priorPeriodValue: z.number().finite().nullable(),
    numeratorValue: z.number().finite().nullable(),
    denominatorValue: z.number().finite().nullable(),
    sourceRefreshedAt: z.string().datetime({ offset: true }),
  })).max(MAX_SQL_ANALYSIS_ROWS),
  signature: z.array(z.object({
    name: z.string().min(1).max(128),
    sqlType: z.string().min(1).max(128),
  })).max(SQL_ANALYSIS_COLUMNS.length),
}).superRefine((execution, ctx) => {
  const names = execution.signature.map(({ name }) => name.toLocaleLowerCase("en-GB"));
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["signature"], message: "Column aliases must be unique." });
  }
  const unexpected = names.filter((name) => !SQL_ANALYSIS_COLUMN_SET.has(name));
  if (unexpected.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["signature"], message: `Unsupported columns: ${unexpected.join(", ")}.` });
  }
  const missing = SQL_ANALYSIS_REQUIRED_COLUMNS.filter((name) => !names.includes(name));
  if (missing.length > 0 || (!names.includes("org_node_id") && !names.includes("org_code"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["signature"], message: "Required semantic columns are missing." });
  }
  for (const [index, row] of execution.rows.entries()) {
    if (!row.orgNodeId && !row.orgCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index], message: "An organisation identifier is required." });
    }
    if (row.periodEnd <= row.periodStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "periodEnd"], message: "Period end must follow period start." });
    }
    if ((row.numeratorValue === null) !== (row.denominatorValue === null) || row.denominatorValue === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index], message: "Numerator and non-zero denominator must be supplied together." });
    }
  }
});

function sqlForInspection(sqlText: string): string {
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
  const inspected = sqlForInspection(normalized);
  if (inspected.includes(";")) throw new Error("SQL analysis must contain one statement only.");
  if (!/^\s*(select\b|with\b)/i.test(inspected)) throw new Error("SQL analysis must be a SELECT or CTE query.");
  const refused = /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|deny|execute|exec|declare|set|use|dbcc|backup|restore|kill|waitfor|openrowset|openquery|opendatasource|bulk)\b/i.exec(inspected);
  if (refused) throw new Error(`SQL analysis cannot use ${refused[1]!.toUpperCase()}.`);
  if (/\bselect\b[\s\S]*?\binto\b/i.test(inspected)) throw new Error("SQL analysis cannot use SELECT INTO.");
  return normalized;
}

function requiredText(row: Record<string, unknown>, key: string, max: number): string {
  const value = String(row[key] ?? "").trim();
  if (!value || value.length > max) throw new Error(`${key} must be present and ${max} characters or fewer.`);
  return value;
}

function nullableNumber(row: Record<string, unknown>, key: string): number | null {
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

export function normalizeSqlAnalysisExecution(
  sourceRows: Array<Record<string, unknown>>,
  signature: Array<{ name: string; sqlType: string }>,
  defaultRefreshedAt = new Date().toISOString(),
): SqlAnalysisExecution {
  if (sourceRows.length > MAX_SQL_ANALYSIS_ROWS) {
    throw new Error(`SQL analysis exceeds ${MAX_SQL_ANALYSIS_ROWS.toLocaleString("en-GB")} rows; aggregate or filter it further.`);
  }
  const names = signature.map(({ name }) => name.toLocaleLowerCase("en-GB"));
  if (new Set(names).size !== names.length) throw new Error("SQL analysis column aliases must be unique.");
  const unexpected = names.filter((name) => !SQL_ANALYSIS_COLUMN_SET.has(name));
  if (unexpected.length > 0) throw new Error(`Unsupported SQL analysis columns: ${unexpected.join(", ")}.`);
  const missing = SQL_ANALYSIS_REQUIRED_COLUMNS.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`SQL analysis is missing required columns: ${missing.join(", ")}.`);
  if (!names.includes("org_node_id") && !names.includes("org_code")) {
    throw new Error("SQL analysis must return org_node_id or org_code for permission-safe results.");
  }
  const rows = sourceRows.map((sourceRow) => {
    const row = Object.fromEntries(Object.entries(sourceRow).map(([key, value]) => [key.toLocaleLowerCase("en-GB"), value]));
    const actualValue = nullableNumber(row, "actual_value");
    if (actualValue === null) throw new Error("actual_value cannot be null.");
    const periodStart = analysisDate(row, "period_start");
    const periodEnd = analysisDate(row, "period_end");
    if (periodEnd <= periodStart) throw new Error("period_end must be later than period_start.");
    const seriesKey = requiredText(row, "series_key", 80);
    if (!/^[a-z][a-z0-9_]*$/.test(seriesKey)) throw new Error("series_key must use lowercase letters, numbers and underscores.");
    const numeratorValue = nullableNumber(row, "numerator_value");
    const denominatorValue = nullableNumber(row, "denominator_value");
    if ((numeratorValue === null) !== (denominatorValue === null) || denominatorValue === 0) {
      throw new Error("numerator_value and non-zero denominator_value must be returned together.");
    }
    const sourceValue = row.source_refreshed_at;
    const sourceDate = sourceValue === null || sourceValue === undefined || sourceValue === ""
      ? new Date(defaultRefreshedAt)
      : sourceValue instanceof Date ? sourceValue : new Date(String(sourceValue));
    if (Number.isNaN(sourceDate.getTime())) throw new Error("source_refreshed_at must be a valid timestamp.");
    return {
      orgNodeId: row.org_node_id === null || row.org_node_id === undefined ? null : String(row.org_node_id).trim(),
      orgCode: row.org_code === null || row.org_code === undefined ? null : String(row.org_code).trim(),
      seriesKey,
      seriesLabel: requiredText(row, "series_label", 120),
      categoryLabel: row.category_label === null || row.category_label === undefined ? "" : String(row.category_label).trim().slice(0, 160),
      periodStart,
      periodEnd,
      actualValue,
      targetValue: nullableNumber(row, "target_value"),
      priorPeriodValue: nullableNumber(row, "prior_period_value"),
      numeratorValue,
      denominatorValue,
      sourceRefreshedAt: sourceDate.toISOString(),
    } satisfies SqlAnalysisSourceRow;
  });
  return sqlAnalysisExecutionSchema.parse({
    rows,
    signature: signature.map(({ name, sqlType }) => ({ name: name.toLocaleLowerCase("en-GB"), sqlType })),
  });
}
