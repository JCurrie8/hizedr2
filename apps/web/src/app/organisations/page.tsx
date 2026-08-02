import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/SignOutButton";
import { getTenantLandingContext, tenantEntryUrl } from "@/server/domains/tenancy/tenant-landing";

export default async function OrganisationsPage() {
  const requestHeaders = await headers();
  const ctx = await getTenantLandingContext(requestHeaders);

  if (ctx.kind === "unauthenticated") redirect("/login");

  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const choices = ctx.tenants.map((tenant) => ({
    ...tenant,
    href: tenantEntryUrl({ slug: tenant.slug, host, protocol }),
  }));

  if (choices.length === 1) redirect(choices[0].href);

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-8 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Hized Platform</p>
            <h1 className="mt-2 font-display text-2xl font-bold text-ink">Choose an organisation</h1>
            <p className="mt-2 text-sm text-muted">
              {ctx.fullName ? `${ctx.fullName}, select` : "Select"} the organisation you want to open.
            </p>
          </div>
          <SignOutButton />
        </div>

        {choices.length > 0 ? (
          <ul className="mt-6 space-y-3">
            {choices.map((tenant) => (
              <li key={tenant.id}>
                <a
                  href={tenant.href}
                  className="flex items-center justify-between rounded-lg border border-line px-4 py-3 transition-colors hover:border-teal-deep hover:bg-canvas"
                >
                  <span>
                    <span className="block font-semibold text-ink">{tenant.name}</span>
                  </span>
                  <span aria-hidden="true" className="text-teal-deep">→</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-6 rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
            Your account has no active organisation memberships. Ask an administrator for an invitation.
          </div>
        )}
      </div>
    </div>
  );
}
