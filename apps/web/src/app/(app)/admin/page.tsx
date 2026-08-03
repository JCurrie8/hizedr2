import { headers } from "next/headers";
import Link from "next/link";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

const settings = [
  {
    title: "Organisation",
    description: "Departments, divisions, regions, teams and reporting structure.",
    path: "/admin/organisation",
    adminOnly: false,
  },
  {
    title: "Users and access",
    description: "Invite colleagues and assign roles, status and organisation scope.",
    path: "/admin/users",
    adminOnly: true,
  },
  {
    title: "Branding",
    description: "Company logo, accessible colours and tenant typography.",
    path: "/admin/branding",
    adminOnly: true,
  },
  {
    title: "Audit log",
    description: "Review privileged changes and access-management activity.",
    path: "/admin/audit",
    adminOnly: true,
  },
] as const;

export default async function SettingsPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  const visibleSettings = settings.filter((item) => !item.adminOnly || ctx.role === "company_admin");

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Tenant settings</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink">Set up {ctx.tenant.name}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
        Manage the company structure and the controls that shape what each person sees. Commercial product access is managed separately by Hized.
      </p>

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        {visibleSettings.map((item) => (
          <Link key={item.path} href={tenantHref(item.path)} className="group rounded-xl border border-line bg-panel p-5 shadow-sm transition hover:border-teal-deep hover:bg-canvas">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold text-ink">{item.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted">{item.description}</p>
              </div>
              <span aria-hidden="true" className="text-lg text-teal-deep transition-transform group-hover:translate-x-1">→</span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
