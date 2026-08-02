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

  it("rewrites admin subdomain paths into the platform-admin namespace", () => {
    const response = proxy(
      new NextRequest("https://admin.hized.com/audit", { headers: { host: "admin.hized.com" } }),
    );
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://admin.hized.com/platform-admin/audit");
  });
});
