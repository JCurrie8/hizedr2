import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { SignOutButton } from "@/components/SignOutButton";

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

  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  const canOperateConnect = ctx.role === "company_admin" || ctx.role === "analyst";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex items-center gap-3 py-3">
            <Link href={tenantHref("/dashboard")} className="min-w-0">
              <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-teal-deep">Hized Pulse</span>
              <span className="block truncate font-display text-lg font-bold text-ink">{ctx.tenant.name}</span>
            </Link>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <div className="hidden min-w-0 text-right sm:block">
                <div className="truncate text-sm font-medium text-ink">{ctx.fullName ?? "You"}</div>
                <div className="text-xs capitalize text-muted">{ctx.role.replaceAll("_", " ")}</div>
              </div>
              <SignOutButton />
            </div>
          </div>
          <nav aria-label="Main navigation" className="-mx-1 flex gap-1 overflow-x-auto pb-3 text-sm [scrollbar-width:none]">
            <Link href={tenantHref("/dashboard")} className="whitespace-nowrap rounded-md bg-navy px-3 py-2 font-semibold text-white">Pulse</Link>
            {canOperateConnect && <Link href={tenantHref("/admin/connect")} className="whitespace-nowrap rounded-md px-3 py-2 text-muted hover:bg-canvas hover:text-ink">Connect</Link>}
            <Link href={tenantHref("/admin/organisation")} className="whitespace-nowrap rounded-md px-3 py-2 text-muted hover:bg-canvas hover:text-ink">Organisation</Link>
            {ctx.role === "company_admin" && <Link href={tenantHref("/admin/users")} className="whitespace-nowrap rounded-md px-3 py-2 text-muted hover:bg-canvas hover:text-ink">Users</Link>}
          </nav>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
