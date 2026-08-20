import { describe, expect, it } from "vitest";
import { sqlServerExtractionWindow } from "./sql-server-sync";

describe("SQL Server extraction windows", () => {
  it("uses a real overlap only after an incremental checkpoint exists", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(sqlServerExtractionWindow({ watermarkField: null, committedThroughAt: "2026-08-19T12:00:00.000Z", overlapSeconds: 86_400, now }))
      .toEqual({ from: null, to: now });
    expect(sqlServerExtractionWindow({ watermarkField: "ModifiedAt", committedThroughAt: null, overlapSeconds: 86_400, now }))
      .toEqual({ from: null, to: now });
    expect(sqlServerExtractionWindow({ watermarkField: "ModifiedAt", committedThroughAt: "2026-08-19T12:00:00.000Z", overlapSeconds: 86_400, now }))
      .toEqual({ from: new Date("2026-08-18T12:00:00.000Z"), to: now });
  });
});
