import { describe, expect, it } from "vitest";
import { tenantAppUrl, tenantEntryUrl } from "./tenant-landing";

describe("tenantEntryUrl", () => {
  it("uses the apex path fallback on Vercel", () => {
    expect(tenantEntryUrl({ slug: "northstar-installations", host: "hized-platform.vercel.app" }))
      .toBe("/t/northstar-installations/home");
  });

  it("uses the canonical tenant subdomain on hized.app", () => {
    expect(tenantEntryUrl({ slug: "harbour-field-services", host: "hized.app" }))
      .toBe("https://harbour-field-services.hized.app/home");
  });

  it("preserves http for local hized.app-style testing", () => {
    expect(tenantEntryUrl({ slug: "acme", host: "admin.hized.app", protocol: "http" }))
      .toBe("http://acme.hized.app/home");
  });

  it("keeps internal tenant navigation inside the Vercel path fallback", () => {
    expect(tenantAppUrl({
      slug: "northstar-installations",
      host: "hized-platform.vercel.app",
      path: "/admin/connect",
    })).toBe("/t/northstar-installations/admin/connect");
  });
});
