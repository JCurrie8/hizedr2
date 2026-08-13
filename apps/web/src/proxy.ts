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
  // Never trust a client-supplied routing header. Only this proxy may derive
  // tenant context, and getAuthContext independently validates membership.
  requestHeaders.delete("x-tenant-slug");
  if (kind === "tenant" && slug) requestHeaders.set("x-tenant-slug", slug);

  // Layouts can't read the pathname directly, but MFA enforcement needs it to
  // exempt the enrolment page (otherwise enforcement is a redirect loop).
  // Deleted first for the same reason as x-tenant-slug: a spoofed
  // "x-pathname: /admin/security" would otherwise let an unenrolled
  // privileged user skip enforcement on every page. Each branch below sets
  // this to the EFFECTIVE path after any rewrite, which is what renders.
  requestHeaders.delete("x-pathname");
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  // Preview deployments and the temporary *.vercel.app production URL
  // cannot represent a tenant as a subdomain. Support /t/:slug/* only on
  // apex hosts, then rewrite it to the normal application route while
  // preserving the visible URL. This is a routing fallback, not an auth
  // shortcut: getAuthContext() still verifies the signed-in identity has
  // an active membership for the derived slug before any tenant query.
  const pathTenant = kind === "apex"
    ? request.nextUrl.pathname.match(/^\/t\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/.*)?$/)
    : null;
  if (pathTenant) {
    requestHeaders.set("x-tenant-slug", pathTenant[1]);
    const url = request.nextUrl.clone();
    url.pathname = pathTenant[2] || "/home";
    requestHeaders.set("x-pathname", url.pathname);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // The public apex is an application entry point, not a marketing or
  // placeholder page. The organisations route resolves the signed-in user
  // and selects their tenant; a tenant hostname enters the product hub.
  if (request.nextUrl.pathname === "/" && kind === "apex") {
    const url = request.nextUrl.clone();
    url.pathname = "/organisations";
    return NextResponse.redirect(url);
  }
  if (request.nextUrl.pathname === "/" && kind === "tenant") {
    const url = request.nextUrl.clone();
    url.pathname = "/home";
    return NextResponse.redirect(url);
  }

  // Every path under admin.* is namespaced to /platform-admin, EXCEPT the
  // shared, top-level routes below (/login, /invite/*, /api/auth/*) —
  // those must resolve the same regardless of which hostname reached
  // them. Earlier version of this only rewrote the exact root path ("/"),
  // which meant /platform-admin/audit was unreachable via admin.*/audit;
  // fixed to a prefix-exclusion instead of an exact-match inclusion.
  const SHARED_PREFIXES = ["/login", "/invite", "/api"];
  // Internal links and Server Action redirects may already use the real App
  // Router namespace. Let those paths pass through instead of prefixing them
  // a second time (which would produce /platform-admin/platform-admin/*).
  if (kind === "admin" && request.nextUrl.pathname.startsWith("/platform-admin")) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  if (kind === "admin" && !SHARED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = `/platform-admin${request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname}`;
    requestHeaders.set("x-pathname", url.pathname);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
