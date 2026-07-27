import { NextResponse, type NextRequest } from "next/server";

/**
 * Hostname → tenant resolution (Phase 0 plan, "Tenant resolution & auth
 * flow"). Deliberately does NO database work here — no per-request
 * Postgres hit, no edge cache to stand up and pay for. It only extracts a
 * slug from the hostname and passes it downstream via a header; the
 * authenticated layout (getAuthContextFromRequest) is what actually
 * validates it against a real tenant + the caller's membership. The
 * hostname is UI/routing only — never the security boundary, per the
 * plan's own point about this.
 */
function parseHost(host: string): { kind: "apex" | "admin" | "tenant"; slug: string | null } {
  const hostname = host.split(":")[0] ?? "";

  if (hostname === "localhost" || hostname === "127.0.0.1") return { kind: "apex", slug: null };
  if (hostname.endsWith(".localhost")) {
    const label = hostname.slice(0, -".localhost".length);
    return label === "admin" ? { kind: "admin", slug: null } : { kind: "tenant", slug: label };
  }

  // Vercel preview URLs (<project>-<hash>.vercel.app) have no tenant concept.
  if (hostname.endsWith(".vercel.app")) return { kind: "apex", slug: null };

  const parts = hostname.split(".");
  if (parts.length <= 2) return { kind: "apex", slug: null }; // e.g. hized.app itself
  const label = parts[0] ?? "";
  return label === "admin" ? { kind: "admin", slug: null } : { kind: "tenant", slug: label };
}

export function proxy(request: NextRequest) {
  const { kind, slug } = parseHost(request.headers.get("host") ?? "");

  const requestHeaders = new Headers(request.headers);
  if (kind === "tenant" && slug) requestHeaders.set("x-tenant-slug", slug);

  // Only the root path is namespaced under /platform-admin — /login,
  // /invite/*, /api/auth/* etc. are shared, top-level routes regardless
  // of which hostname reached them, and must NOT be rewritten (a blanket
  // rewrite here 404s them, since e.g. no /platform-admin/login exists).
  if (kind === "admin" && request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/platform-admin";
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
