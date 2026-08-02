import { describe, expect, it } from "vitest";
import { prepareTabularLoad } from "./tabular-load";

const table = {
  sourceName: "responses.xlsx",
  sheetName: "Form1",
  headers: ["Response ID", "Score"],
  rows: [
    { "Response ID": "a", Score: 7 },
    { "Response ID": "b", Score: 8 },
  ],
};

describe("tabular load preparation", () => {
  it("generates stable upsert keys from configured business keys", () => {
    const first = prepareTabularLoad({ table, loadMode: "upsert", keyColumns: ["Response ID"], contentSha256: "a".repeat(64) });
    const replay = prepareTabularLoad({ table, loadMode: "upsert", keyColumns: ["Response ID"], contentSha256: "b".repeat(64) });
    expect(replay.curatedRecords.map((row) => row.recordKey)).toEqual(first.curatedRecords.map((row) => row.recordKey));
  });

  it("quarantines missing and duplicate source keys", () => {
    const result = prepareTabularLoad({
      table: { ...table, rows: [{ "Response ID": "a", Score: 7 }, { "Response ID": "a", Score: 8 }, { "Response ID": null, Score: 9 }] },
      loadMode: "upsert",
      keyColumns: ["Response ID"],
      contentSha256: "a".repeat(64),
    });
    expect(result.rejectedRows).toBe(2);
    expect(result.landedRows[1]?.rejectionReasons).toContain("duplicate_key_in_source");
    expect(result.landedRows[2]?.rejectionReasons).toContain("missing_key_value");
  });

  it("uses content plus row position for append idempotency", () => {
    const result = prepareTabularLoad({ table, loadMode: "append", keyColumns: [], contentSha256: "c".repeat(64) });
    expect(result.curatedRecords[0]?.recordKey).toBe(`${"c".repeat(64)}:1`);
  });

  it("rejects an upsert when a configured key column disappears", () => {
    expect(() => prepareTabularLoad({ table, loadMode: "upsert", keyColumns: ["Email"], contentSha256: "a".repeat(64) }))
      .toThrow(/missing configured key columns: Email/);
  });
});
