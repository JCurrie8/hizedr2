import { describe, expect, it } from "vitest";
import { salesforceExtractionWindow } from "./salesforce-sync";

describe("Salesforce extraction checkpoints", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");

  it("uses the configured initial window for a bounded bootstrap", () => {
    const window = salesforceExtractionWindow({
      committedThroughAt: null,
      overlapSeconds: 86_400,
      initialLookbackSeconds: 30 * 86_400,
      now,
    });
    expect(window.from?.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(window.to).toBe(now);
  });

  it("leaves the lower bound open for an intentional full bootstrap", () => {
    const window = salesforceExtractionWindow({
      committedThroughAt: null,
      overlapSeconds: 86_400,
      initialLookbackSeconds: null,
      now,
    });
    expect(window).toEqual({ from: null, to: now });
  });

  it("re-reads a real 24-hour overlap from the last committed high-water mark", () => {
    const window = salesforceExtractionWindow({
      committedThroughAt: "2026-08-14T09:30:00.000Z",
      overlapSeconds: 86_400,
      initialLookbackSeconds: null,
      now,
    });
    expect(window.from?.toISOString()).toBe("2026-08-13T09:30:00.000Z");
    expect(window.to).toBe(now);
  });
});
