import { describe, expect, it } from "vitest";
import { assertGraphDeltaUrl, planSharePointDeltaPage } from "./sharepoint-delta";

describe("SharePoint drive delta reconciliation", () => {
  it("uses the last occurrence of an item and does not checkpoint an intermediate page", () => {
    const plan = planSharePointDeltaPage({
      page: {
        value: [
          { id: "form", name: "responses.xlsx", file: {}, eTag: "old", size: 10 },
          {
            id: "form",
            name: "responses.xlsx",
            file: {},
            eTag: "new",
            size: 20,
            lastModifiedDateTime: "2026-08-02T12:00:00Z",
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=page-2",
      },
    });

    expect(plan).toEqual({
      changes: [{
        kind: "download",
        driveItemId: "form",
        sourceName: "responses.xlsx",
        sourceETag: "new",
        sourceCTag: null,
        sourceModifiedAt: "2026-08-02T12:00:00.000Z",
        sizeBytes: 20,
      }],
      nextPageUrl: "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=page-2",
      checkpointCandidate: null,
    });
  });

  it("emits selected workbook deletion state and a final checkpoint", () => {
    const plan = planSharePointDeltaPage({
      selectedItemIds: new Set(["selected"]),
      page: {
        value: [
          { id: "selected", deleted: {} },
          { id: "ignored", name: "other.xlsx", file: {} },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=complete",
      },
    });
    expect(plan.changes).toEqual([{ kind: "delete", driveItemId: "selected" }]);
    expect(plan.nextPageUrl).toBeNull();
    expect(plan.checkpointCandidate).toContain("token=complete");
  });

  it("ignores folders and file formats outside the shared tabular parser", () => {
    const plan = planSharePointDeltaPage({
      page: {
        value: [
          { id: "folder", name: "Forms", folder: {} },
          { id: "xls", name: "legacy.xls", file: {} },
          { id: "pdf", name: "report.pdf", file: {} },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=complete",
      },
    });
    expect(plan.changes).toEqual([]);
  });

  it("rejects a continuation URL that could redirect server extraction off Graph", () => {
    expect(() => assertGraphDeltaUrl("https://attacker.example/v1.0/drives/drive/root/delta?token=stolen"))
      .toThrow(/invalid delta continuation URL/);
  });
});
