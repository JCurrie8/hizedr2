import { createHash } from "node:crypto";
import type { ParsedTable, TabularValue } from "./tabular-file";

export type LoadMode = "snapshot" | "append" | "upsert";

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

export function prepareTabularLoad(input: {
  table: ParsedTable;
  loadMode: LoadMode;
  keyColumns: string[];
  contentSha256: string;
}): { landedRows: PreparedLandedRow[]; curatedRecords: PreparedCuratedRecord[]; rejectedRows: number } {
  const headerSet = new Set(input.table.headers);
  const missingColumns = input.keyColumns.filter((column) => !headerSet.has(column));
  if (input.loadMode === "upsert" && missingColumns.length > 0) {
    throw new Error(`The file is missing configured key columns: ${missingColumns.join(", ")}.`);
  }

  const seenKeys = new Set<string>();
  const landedRows: PreparedLandedRow[] = [];
  const curatedRecords: PreparedCuratedRecord[] = [];

  input.table.rows.forEach((data, index) => {
    const rowNumber = index + 1;
    let recordKey: string;
    const rejectionReasons: string[] = [];

    if (input.loadMode === "upsert") {
      const keyValues = input.keyColumns.map((column) => data[column]);
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
