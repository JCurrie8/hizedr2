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
  if (parts.length <= 2) return { kind: "apex", slug: null }; // e.g. hized.com itself
  const label = parts[0] ?? "";
  return label === "admin" ? { kind: "admin", slug: null } : { kind: "tenant", slug: label };
}

export function proxy(request: NextRequest) {
  const { kind, slug } = parseHost(request.headers.get("host") ?? "");

  const requestHeaders = new Headers(request.headers);
  // Never trust a client-supplied routing header. Only this proxy may derive
  // tenant context, and getAuthContext independently validates membership.
  requestHeaders.delete("x-tenant-slug");
  if (kind === "tenant" && slug) requestHeaders.set("x-tenant-slug", slug);

  // Every path under admin.* is namespaced to /platform-admin, EXCEPT the
  // shared, top-level routes below (/login, /invite/*, /api/auth/*) —
  // those must resolve the same regardless of which hostname reached
  // them. Earlier version of this only rewrote the exact root path ("/"),
  // which meant /platform-admin/audit was unreachable via admin.*/audit;
  // fixed to a prefix-exclusion instead of an exact-match inclusion.
  const SHARED_PREFIXES = ["/login", "/invite", "/api"];
  if (kind === "admin" && !SHARED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = `/platform-admin${request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname}`;
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
