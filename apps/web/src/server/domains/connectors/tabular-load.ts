import { createHash } from "node:crypto";
import type { ParsedTable, TabularValue } from "./tabular-file";

export type LoadMode = "snapshot" | "append" | "upsert";
export type PipelineDataType = "string" | "integer" | "numeric" | "boolean" | "date" | "timestamp";

export interface PipelineFieldMapping {
  sourceField: string;
  targetField: string;
  dataType: PipelineDataType;
  isIncluded: boolean;
  isRequired: boolean;
  position: number;
}

export interface PreparedLandedRow {
  rowNumber: number;
  disposition: "accepted" | "quarantined";
  recordKey: string | null;
  data: Record<string, TabularValue>;
  rejectionReasons: string[];
}

export interface PreparedCuratedRecord {
  recordKey: string;
  rowNumber: number;
  data: Record<string, TabularValue>;
}

function hashKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coerceValue(value: TabularValue, dataType: PipelineDataType): { value: TabularValue; valid: boolean } {
  if (value === null) return { value: null, valid: true };
  if (dataType === "string") return { value: String(value), valid: true };

  if (dataType === "integer") {
    if (typeof value === "number" && Number.isSafeInteger(value)) return { value, valid: true };
    const raw = String(value).trim();
    if (/^[+-]?\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed)) return { value: parsed, valid: true };
    }
    return { value: null, valid: false };
  }

  if (dataType === "numeric") {
    if (typeof value === "number" && Number.isFinite(value)) return { value, valid: true };
    const raw = String(value).trim();
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return { value: parsed, valid: true };
    }
    return { value: null, valid: false };
  }

  if (dataType === "boolean") {
    if (typeof value === "boolean") return { value, valid: true };
    const normalized = String(value).trim().toLocaleLowerCase("en-GB");
    if (["true", "yes", "1"].includes(normalized)) return { value: true, valid: true };
    if (["false", "no", "0"].includes(normalized)) return { value: false, valid: true };
    return { value: null, valid: false };
  }

  const raw = String(value).trim();
  if (dataType === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return { value: null, valid: false };
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === raw
      ? { value: raw, valid: true }
      : { value: null, valid: false };
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf())
    ? { value: null, valid: false }
    : { value: parsed.toISOString(), valid: true };
}

function applyMappings(
  table: ParsedTable,
  mappings: PipelineFieldMapping[],
): { headers: string[]; rows: Array<{ data: Record<string, TabularValue>; rejectionReasons: string[] }> } {
  const activeMappings = mappings
    .filter((mapping) => mapping.isIncluded)
    .sort((left, right) => left.position - right.position);
  if (activeMappings.length === 0) {
    return { headers: table.headers, rows: table.rows.map((data) => ({ data, rejectionReasons: [] })) };
  }

  const sourceHeaders = new Map(table.headers.map((header) => [header.toLocaleLowerCase("en-GB"), header]));
  const missing = activeMappings.filter((mapping) => !sourceHeaders.has(mapping.sourceField.toLocaleLowerCase("en-GB")));
  if (missing.length > 0) {
    throw new Error(`The source is missing configured fields: ${missing.map((mapping) => mapping.sourceField).join(", ")}.`);
  }

  const targetHeaders = new Set<string>();
  for (const mapping of activeMappings) {
    const target = mapping.targetField.toLocaleLowerCase("en-GB");
    if (targetHeaders.has(target)) throw new Error(`The pipeline maps more than one field to '${mapping.targetField}'.`);
    targetHeaders.add(target);
  }

  return {
    headers: activeMappings.map((mapping) => mapping.targetField),
    rows: table.rows.map((sourceRow) => {
      const data: Record<string, TabularValue> = Object.create(null);
      const rejectionReasons: string[] = [];
      for (const mapping of activeMappings) {
        const sourceHeader = sourceHeaders.get(mapping.sourceField.toLocaleLowerCase("en-GB"))!;
        const sourceValue = sourceRow[sourceHeader] ?? null;
        const coerced = coerceValue(sourceValue, mapping.dataType);
        data[mapping.targetField] = coerced.value;
        if (!coerced.valid) rejectionReasons.push(`invalid_type:${mapping.targetField}`);
        if (mapping.isRequired && (sourceValue === null || sourceValue === "")) {
          rejectionReasons.push(`required:${mapping.targetField}`);
        }
      }
      return { data, rejectionReasons };
    }),
  };
}

export function prepareTabularLoad(input: {
  table: ParsedTable;
  loadMode: LoadMode;
  keyColumns: string[];
  contentSha256: string;
  fieldMappings?: PipelineFieldMapping[];
}): { landedRows: PreparedLandedRow[]; curatedRecords: PreparedCuratedRecord[]; rejectedRows: number } {
  const mapped = applyMappings(input.table, input.fieldMappings ?? []);
  const headerLookup = new Map(mapped.headers.map((header) => [header.toLocaleLowerCase("en-GB"), header]));
  const missingColumns = input.keyColumns.filter((column) => !headerLookup.has(column.toLocaleLowerCase("en-GB")));
  if (input.loadMode === "upsert" && missingColumns.length > 0) {
    throw new Error(`The file is missing configured key columns: ${missingColumns.join(", ")}.`);
  }

  const seenKeys = new Set<string>();
  const landedRows: PreparedLandedRow[] = [];
  const curatedRecords: PreparedCuratedRecord[] = [];

  mapped.rows.forEach(({ data, rejectionReasons: mappingRejections }, index) => {
    const rowNumber = index + 1;
    let recordKey: string;
    const rejectionReasons = [...mappingRejections];

    if (input.loadMode === "upsert") {
      const keyValues = input.keyColumns.map((column) => data[headerLookup.get(column.toLocaleLowerCase("en-GB"))!]);
      if (keyValues.some((value) => value === null || value === "")) rejectionReasons.push("missing_key_value");
      recordKey = hashKey(keyValues);
      if (seenKeys.has(recordKey)) rejectionReasons.push("duplicate_key_in_source");
      seenKeys.add(recordKey);
    } else if (input.loadMode === "append") {
      recordKey = `${input.contentSha256}:${rowNumber}`;
    } else {
      recordKey = String(rowNumber);
    }

    const disposition = rejectionReasons.length > 0 ? "quarantined" : "accepted";
    landedRows.push({ rowNumber, disposition, recordKey, data, rejectionReasons });
    if (disposition === "accepted") curatedRecords.push({ recordKey, rowNumber, data });
  });

  return {
    landedRows,
    curatedRecords,
    rejectedRows: landedRows.length - curatedRecords.length,
  };
}
