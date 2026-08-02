import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseCsvTable, parseTabularFile, parseXlsxTable } from "./tabular-file";

describe("tabular file parsing", () => {
  it("parses a Forms-style CSV with stable headers and blank values", () => {
    const table = parseCsvTable(
      Buffer.from("Response ID,Submitted at,Score\nabc,2026-08-02T09:30:00Z,7\ndef,,9\n"),
      "responses.csv",
    );
    expect(table.headers).toEqual(["Response ID", "Submitted at", "Score"]);
    expect(table.rows).toEqual([
      { "Response ID": "abc", "Submitted at": "2026-08-02T09:30:00Z", Score: "7" },
      { "Response ID": "def", "Submitted at": null, Score: "9" },
    ]);
  });

  it("reads the requested worksheet and uses cached formula results", async () => {
    const workbook = new ExcelJS.Workbook();
    const ignored = workbook.addWorksheet("Notes");
    ignored.addRow(["Note"]);
    const responses = workbook.addWorksheet("Form1");
    responses.addRow(["Response ID", "Submitted at", "Double score"]);
    responses.addRow(["abc", new Date("2026-08-02T09:30:00.000Z"), { formula: "4*2", result: 8 }]);
    const bytes = await workbook.xlsx.writeBuffer();

    const table = await parseXlsxTable(new Uint8Array(bytes), "responses.xlsx", "Form1");
    expect(table.sheetName).toBe("Form1");
    expect(table.rows).toEqual([
      { "Response ID": "abc", "Submitted at": "2026-08-02T09:30:00.000Z", "Double score": 8 },
    ]);
  });

  it("rejects duplicate headers case-insensitively", () => {
    expect(() => parseCsvTable(Buffer.from("Email,email\na@example.com,b@example.com"), "duplicate.csv"))
      .toThrow(/duplicate header/i);
  });

  it("rejects prototype-polluting header names", () => {
    expect(() => parseCsvTable(Buffer.from("__proto__,Value\nunsafe,1"), "unsafe.csv"))
      .toThrow(/reserved/);
  });

  it("rejects unsupported legacy workbook formats explicitly", async () => {
    await expect(parseTabularFile({ bytes: Buffer.from("not-an-xls"), fileName: "legacy.xls" }))
      .rejects.toThrow(/Only \.csv and \.xlsx/);
  });
});
