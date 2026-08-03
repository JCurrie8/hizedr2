import { withUserContext } from "@hized/db";
import { dbPool } from "../../db-pool";
import { auth } from "../identity/auth";

export interface TenantChoice {
  id: string;
  slug: string;
  name: string;
}

export type TenantLandingContext =
  | { kind: "unauthenticated" }
  | { kind: "authenticated"; fullName: string | null; tenants: TenantChoice[] };

export async function listTenantChoices(profileId: string): Promise<TenantChoice[]> {
  return withUserContext({ userId: profileId }, async (client) => {
    const { rows } = await client.query(
      `select t.id, t.slug, t.name
       from public.tenants t
       where t.id = any(public.current_user_tenant_ids())
       order by t.name`,
    );
    return rows as TenantChoice[];
  });
}

/**
 * Resolves the signed-in identity once, then lists only its active tenant
 * memberships without selecting a tenant first. The explicit
 * current_user_tenant_ids() predicate is important: platform admins can
 * ordinarily see all tenant rows, but the organisation picker must show
 * memberships, not every client on the platform.
 */
export async function getTenantLandingContext(requestHeaders: Headers): Promise<TenantLandingContext> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { kind: "unauthenticated" };

  const { rows: [profile] } = await dbPool.query(
    "select * from public.get_profile_for_auth_user($1)",
    [session.user.id],
  );
  if (!profile) return { kind: "unauthenticated" };

  const tenants = await listTenantChoices(profile.profile_id);

  return { kind: "authenticated", fullName: profile.full_name, tenants };
}

export function tenantEntryUrl(opts: { slug: string; host: string; protocol?: string }): string {
  return tenantAppUrl({ ...opts, path: "/dashboard" });
}

export function tenantAppUrl(opts: { slug: string; host: string; protocol?: string; path: string }): string {
  const hostname = opts.host.toLowerCase().split(":")[0] ?? "";
  const protocol = opts.protocol === "http" ? "http" : "https";
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;

  if (hostname === "hized.app" || hostname.endsWith(".hized.app")) {
    return `${protocol}://${opts.slug}.hized.app${path}`;
  }

  return `/t/${encodeURIComponent(opts.slug)}${path}`;
}
