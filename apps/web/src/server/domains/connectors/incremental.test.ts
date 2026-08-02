import { describe, expect, it } from "vitest";
import {
  planModifiedSinceWindow,
  planSalesforceExtract,
  planZendeskExtract,
  salesforceCheckpointAfterSuccess,
  zendeskCheckpointAfterPage,
} from "./incremental";

describe("incremental connector planning", () => {
  it("replays the prior 24 hours before a Salesforce high-water mark", () => {
    const extract = planSalesforceExtract({
      config: {
        object: "Opportunity",
        fields: ["Id", "Name", "Amount", "SystemModstamp"],
        primaryKey: "Id",
        modifiedField: "SystemModstamp",
        includeDeleted: true,
        initialLookbackSeconds: 86_400,
        overlapSeconds: 86_400,
        bulkThreshold: 2_000,
      },
      committedThroughAt: "2026-08-01T12:00:00.000Z",
      now: new Date("2026-08-02T15:00:00.000Z"),
    });

    expect(extract.window).toEqual({
      startInclusive: "2026-07-31T12:00:00.000Z",
      endExclusive: "2026-08-02T15:00:00.000Z",
    });
    expect(extract.soql).toContain("WHERE SystemModstamp >= 2026-07-31T12:00:00.000Z");
    expect(extract.soql).toContain("AND SystemModstamp < 2026-08-02T15:00:00.000Z");
    expect(extract.soql).toContain("ORDER BY SystemModstamp ASC, Id ASC");
    expect(extract.useQueryAll).toBe(true);
  });

  it("uses the initial lookback when Salesforce has no checkpoint", () => {
    expect(
      planModifiedSinceWindow({
        now: new Date("2026-08-02T15:00:00.000Z"),
        overlapSeconds: 86_400,
        initialLookbackSeconds: 172_800,
      }),
    ).toEqual({
      startInclusive: "2026-07-31T15:00:00.000Z",
      endExclusive: "2026-08-02T15:00:00.000Z",
    });
  });

  it("rejects an unsafe Salesforce API identifier before it reaches SOQL", () => {
    expect(() =>
      planSalesforceExtract({
        config: {
          object: "Opportunity WHERE Name != null",
          fields: ["Id", "SystemModstamp"],
          primaryKey: "Id",
          modifiedField: "SystemModstamp",
          includeDeleted: false,
          initialLookbackSeconds: 86_400,
          overlapSeconds: 86_400,
          bulkThreshold: 2_000,
        },
        now: new Date("2026-08-02T15:00:00.000Z"),
      }),
    ).toThrow(/Invalid Salesforce object API name/);
  });

  it("produces a Salesforce checkpoint candidate at the exclusive window end", () => {
    expect(
      salesforceCheckpointAfterSuccess({
        startInclusive: "2026-08-01T15:00:00.000Z",
        endExclusive: "2026-08-02T15:00:00.000Z",
      }),
    ).toEqual({ strategy: "modified_since", committedThroughAt: "2026-08-02T15:00:00.000Z" });
  });

  it("starts Zendesk from a timestamp, then resumes from its opaque cursor", () => {
    const config = {
      resource: "tickets" as const,
      initialLookbackSeconds: 86_400,
      perPage: 1_000,
    };
    expect(planZendeskExtract({ config, now: new Date("2026-08-02T15:00:00.000Z") })).toMatchObject({
      startTime: 1_785_596_400,
    });
    expect(
      planZendeskExtract({ config, now: new Date("2026-08-02T15:00:00.000Z"), checkpoint: { afterCursor: "opaque" } }),
    ).toMatchObject({ cursor: "opaque" });
  });

  it("does not advance a Zendesk checkpoint until the full stream completes", () => {
    expect(zendeskCheckpointAfterPage({ afterCursor: "page-2", endOfStream: false })).toBeNull();
    expect(zendeskCheckpointAfterPage({ afterCursor: "page-3", endOfStream: true })).toEqual({
      afterCursor: "page-3",
    });
  });
});
