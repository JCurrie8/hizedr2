import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import type { CSSProperties } from "react";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import {
  accessibleForeground,
  brandingFontVariables,
  getPublishedBranding,
} from "@/server/domains/branding/branding";
import { entitlementStatus, listProductEntitlements } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { SignOutButton } from "@/components/SignOutButton";
import { TenantNavigation } from "@/components/TenantNavigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContextFromRequest();

  if (ctx.kind === "unauthenticated") redirect("/login");

  if (ctx.kind === "forbidden") {
    const requestHeaders = await headers();
    if (!requestHeaders.get("x-tenant-slug")) redirect("/organisations");

    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md px-8 text-center">
          <h1 className="font-display text-2xl font-bold text-ink">Access denied</h1>
          <p className="mt-3 text-sm text-muted">
            You don&apos;t have access to this organisation, or it doesn&apos;t exist.
          </p>
        </div>
      </div>
    );
  }

  if (ctx.kind === "platform_admin") redirect("/"); // platform admins operate from admin.*, not a tenant subdomain

  const [requestHeaders, { branding, entitlements }] = await Promise.all([
    headers(),
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => ({
        branding: await getPublishedBranding(client, { tenantId: ctx.tenant.id }),
        entitlements: await listProductEntitlements(client, { tenantId: ctx.tenant.id }),
      }),
    ),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  const canOperateConnect = ctx.role === "company_admin" || ctx.role === "analyst";
  const hasPulse = entitlementStatus(entitlements, "pulse") !== "locked";
  const hasCanvas = entitlementStatus(entitlements, "canvas") !== "locked";
  const hasConnect = entitlementStatus(entitlements, "connect") !== "locked";
  const fonts = brandingFontVariables(branding.typography);
  const themeStyle = {
    "--tenant-primary": branding.primaryColor,
    "--tenant-primary-foreground": accessibleForeground(branding.primaryColor),
    "--tenant-accent": branding.accentColor,
    "--tenant-accent-foreground": accessibleForeground(branding.accentColor),
    "--tenant-font-body": fonts.body,
    "--tenant-font-heading": fonts.heading,
  } as CSSProperties;

  return (
    <div className="tenant-theme flex min-h-screen flex-col" style={themeStyle}>
      <header className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex items-center gap-3 py-3">
            <Link href={tenantHref("/home")} className="flex min-w-0 items-center gap-3">
              {branding.logoObjectKey && (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated tenant-private logo route.
                <img
                  src={`/api/branding/logo?v=${encodeURIComponent(branding.changedAt ?? "published")}`}
                  alt={`${ctx.tenant.name} logo`}
                  className="h-9 max-w-32 shrink-0 object-contain object-left"
                />
              )}
              <span className="min-w-0">
                <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted">Hized Platform</span>
                <span className="block truncate font-display text-lg font-bold text-ink">{ctx.tenant.name}</span>
              </span>
            </Link>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <div className="hidden min-w-0 text-right sm:block">
                <div className="truncate text-sm font-medium text-ink">{ctx.fullName ?? "You"}</div>
                <div className="text-xs capitalize text-muted">{ctx.role.replaceAll("_", " ")}</div>
              </div>
              <SignOutButton />
            </div>
          </div>
          <TenantNavigation items={[
            { label: "Home", href: tenantHref("/home"), section: "home" },
            ...(hasPulse ? [{ label: "Pulse", href: tenantHref("/dashboard"), section: "pulse" as const }] : []),
            ...(hasCanvas ? [{ label: "Canvas", href: tenantHref("/canvas"), section: "canvas" as const }] : []),
            ...(hasConnect && canOperateConnect ? [{ label: "Connect", href: tenantHref("/admin/connect"), section: "connect" as const }] : []),
            { label: "Settings", href: tenantHref("/admin"), section: "settings" },
          ]} />
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
