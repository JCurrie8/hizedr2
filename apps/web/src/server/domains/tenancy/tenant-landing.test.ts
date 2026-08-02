import { describe, expect, it } from "vitest";
import { tenantEntryUrl } from "./tenant-landing";

describe("tenantEntryUrl", () => {
  it("uses the apex path fallback on Vercel", () => {
    expect(tenantEntryUrl({ slug: "northstar-installations", host: "hized-platform.vercel.app" }))
      .toBe("/t/northstar-installations/dashboard");
  });

  it("uses the canonical tenant subdomain on hized.com", () => {
    expect(tenantEntryUrl({ slug: "harbour-field-services", host: "hized.com" }))
      .toBe("https://harbour-field-services.hized.com/dashboard");
  });

  it("preserves http for local hized.com-style testing", () => {
    expect(tenantEntryUrl({ slug: "acme", host: "admin.hized.com", protocol: "http" }))
      .toBe("http://acme.hized.com/dashboard");
  });
});
