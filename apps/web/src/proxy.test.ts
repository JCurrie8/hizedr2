import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("tenant proxy", () => {
  it("overwrites a client-supplied tenant header from a tenant hostname", () => {
    const response = proxy(
      new NextRequest("http://acme.localhost:3001/dashboard", {
        headers: { host: "acme.localhost:3001", "x-tenant-slug": "spoofed" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-tenant-slug")).toBe("acme");
  });

  it("removes a client-supplied tenant header on an apex hostname", () => {
    const response = proxy(
      new NextRequest("http://localhost:3001/dashboard", {
        headers: { host: "localhost:3001", "x-tenant-slug": "spoofed" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-tenant-slug")).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")).not.toContain("x-tenant-slug");
  });

  it("rewrites the apex path fallback with a server-derived tenant header", () => {
    const response = proxy(
      new NextRequest("https://hized-platform.vercel.app/t/northstar-installations/dashboard", {
        headers: { host: "hized-platform.vercel.app", "x-tenant-slug": "spoofed" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-tenant-slug")).toBe("northstar-installations");
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://hized-platform.vercel.app/dashboard");
  });

  it("does not let an apex path override a real tenant hostname", () => {
    const response = proxy(
      new NextRequest("https://acme.hized.com/t/spoofed/dashboard", {
        headers: { host: "acme.hized.com" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-tenant-slug")).toBe("acme");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("rewrites admin subdomain paths into the platform-admin namespace", () => {
    const response = proxy(
      new NextRequest("https://admin.hized.com/audit", { headers: { host: "admin.hized.com" } }),
    );
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://admin.hized.com/platform-admin/audit");
  });
});
