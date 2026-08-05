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

  it("overwrites a client-supplied x-pathname so MFA enforcement can't be skipped", () => {
    // MFA enforcement exempts the enrolment page by pathname. If a client
    // could assert "x-pathname: /admin/security" on every request, an
    // unenrolled Company Admin would bypass enforcement everywhere.
    const response = proxy(
      new NextRequest("http://acme.localhost:3001/dashboard", {
        headers: { host: "acme.localhost:3001", "x-pathname": "/admin/security" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/dashboard");
  });

  it("reports the post-rewrite path for admin hostnames, not the requested one", () => {
    const response = proxy(
      new NextRequest("https://admin.hized.app/security", { headers: { host: "admin.hized.app" } }),
    );
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/platform-admin/security");
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
      new NextRequest("https://acme.hized.app/t/spoofed/dashboard", {
        headers: { host: "acme.hized.app" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-tenant-slug")).toBe("acme");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("rewrites admin subdomain paths into the platform-admin namespace", () => {
    const response = proxy(
      new NextRequest("https://admin.hized.app/audit", { headers: { host: "admin.hized.app" } }),
    );
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://admin.hized.app/platform-admin/audit");
  });

  it("routes the apex root through the signed-in organisation chooser", () => {
    const response = proxy(
      new NextRequest("https://hized.app/", { headers: { host: "hized.app" } }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://hized.app/organisations");
  });

  it("routes a tenant root into the product hub", () => {
    const response = proxy(
      new NextRequest("https://northstar.hized.app/", { headers: { host: "northstar.hized.app" } }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://northstar.hized.app/home");
  });
});
