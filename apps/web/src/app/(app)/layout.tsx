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
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <span className="font-display text-lg font-bold text-ink">{ctx.tenant.name}</span>
          <nav className="ml-auto flex items-center gap-4 text-sm text-muted">
            <Link href={tenantHref("/dashboard")} className="hover:text-ink">Pulse</Link>
            {canOperateConnect && <Link href={tenantHref("/admin/connect")} className="hover:text-ink">Connect</Link>}
            <Link href={tenantHref("/admin/organisation")} className="hover:text-ink">Organisation</Link>
            {ctx.role === "company_admin" && <Link href={tenantHref("/admin/users")} className="hover:text-ink">Users</Link>}
            <span>
              {ctx.fullName ?? "You"} · {ctx.role.replace("_", " ")}
            </span>
            <SignOutButton />
          </nav>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
