import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 250;
const FORBIDDEN_HEADERS = new Set(["__proto__", "constructor", "prototype"]);

export type TabularValue = string | number | boolean | null;

export interface ParsedTable {
  sourceName: string;
  sheetName: string | null;
  headers: string[];
  rows: Array<Record<string, TabularValue>>;
}

function validateFileSize(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new Error("The source file is empty.");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("The source file exceeds the 10 MB parsing limit.");
}

function normalizeHeaders(values: unknown[]): string[] {
  if (values.length > MAX_COLUMNS) throw new Error(`The source has more than ${MAX_COLUMNS} columns.`);
  const headers = values.map((value) => String(value ?? "").trim());
  if (headers.length === 0 || headers.every((header) => !header)) throw new Error("The source has no header row.");
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) throw new Error("Every source column must have a header.");
    const normalized = header.toLocaleLowerCase("en-GB");
    if (FORBIDDEN_HEADERS.has(normalized)) throw new Error(`The header '${header}' is reserved.`);
    if (seen.has(normalized)) throw new Error(`The source contains a duplicate header: ${header}.`);
    seen.add(normalized);
  }
  return headers;
}

function toRecord(headers: string[], values: unknown[]): Record<string, TabularValue> {
  if (values.length > headers.length) throw new Error("A source row has more values than the header row.");
  const record: Record<string, TabularValue> = Object.create(null);
  headers.forEach((header, index) => {
    record[header] = normalizeValue(values[index]);
  });
  return record;
}

function normalizeValue(value: unknown): TabularValue {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    const cell = value as {
      result?: unknown;
      text?: string;
      hyperlink?: string;
      richText?: Array<{ text?: string }>;
      error?: string;
    };
    if ("result" in cell) return normalizeValue(cell.result);
    if (cell.text !== undefined) return cell.text;
    if (cell.richText) return cell.richText.map((part) => part.text ?? "").join("");
    if (cell.hyperlink) return cell.hyperlink;
    if (cell.error) return cell.error;
  }
  return String(value);
}

function rejectOversizedRowSet(rowCount: number) {
  if (rowCount > MAX_ROWS) throw new Error(`The source has more than ${MAX_ROWS.toLocaleString("en-GB")} data rows.`);
}

export function parseCsvTable(bytes: Uint8Array, sourceName: string): ParsedTable {
  validateFileSize(bytes);
  const matrix = parseCsv(Buffer.from(bytes), {
    bom: true,
    columns: false,
    skip_empty_lines: true,
    relax_column_count_less: true,
    relax_column_count_more: false,
    trim: false,
  }) as unknown[][];
  if (matrix.length === 0) throw new Error("The CSV file contains no rows.");
  rejectOversizedRowSet(matrix.length - 1);
  const headers = normalizeHeaders(matrix[0] ?? []);
  return {
    sourceName,
    sheetName: null,
    headers,
    rows: matrix.slice(1).map((values) => toRecord(headers, values)),
  };
}

export async function parseXlsxTable(
  bytes: Uint8Array,
  sourceName: string,
  requestedSheetName?: string,
): Promise<ParsedTable> {
  validateFileSize(bytes);
  const workbook = new ExcelJS.Workbook();
  // ExcelJS's declaration models its input as an ArrayBuffer-like Buffer;
  // copying also prevents an offset Uint8Array from exposing adjacent bytes.
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const worksheet = requestedSheetName
    ? workbook.getWorksheet(requestedSheetName)
    : workbook.worksheets[0];
  if (!worksheet) throw new Error(requestedSheetName ? `Worksheet '${requestedSheetName}' was not found.` : "The workbook has no worksheets.");

  const matrix: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    // ExcelJS values are one-indexed and may contain an empty element 0.
    matrix.push(Array.from({ length: row.cellCount }, (_, index) => row.getCell(index + 1).value));
  });
  if (matrix.length === 0) throw new Error("The worksheet contains no rows.");
  rejectOversizedRowSet(matrix.length - 1);
  const headers = normalizeHeaders(matrix[0] ?? []);
  return {
    sourceName,
    sheetName: worksheet.name,
    headers,
    rows: matrix.slice(1).map((values) => toRecord(headers, values)),
  };
}

export async function parseTabularFile(input: {
  bytes: Uint8Array;
  fileName: string;
  sheetName?: string;
}): Promise<ParsedTable> {
  const extension = input.fileName.toLocaleLowerCase("en-GB").split(".").pop();
  if (extension === "csv") return parseCsvTable(input.bytes, input.fileName);
  if (extension === "xlsx") return parseXlsxTable(input.bytes, input.fileName, input.sheetName);
  throw new Error("Only .csv and .xlsx files are supported.");
}
