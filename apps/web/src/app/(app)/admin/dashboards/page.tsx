import { withUserContext } from "@hized/db";
import Link from "next/link";
import { headers } from "next/headers";
import { createAnalyticsViewAction } from "@/app/(app)/analytics-actions";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listAnalyticsViews } from "@/server/domains/analytics/visual-views";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

export default async function PulseViewsPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") return <div className="mx-auto w-full max-w-4xl px-4 py-10"><h1 className="font-display text-2xl font-bold text-ink">Pulse configuration is restricted</h1><p className="mt-3 text-sm text-muted">A Company Admin or Analyst can build and publish the company view.</p></div>;
  const [requestHeaders, views] = await Promise.all([
    headers(),
    withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
      await assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" });
      return listAnalyticsViews(client, { tenantId: ctx.tenant.id, surface: "pulse" });
    }),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const href = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  return <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
    <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Pulse configuration</p>
    <h1 className="mt-2 font-display text-3xl font-bold text-ink">Company performance views</h1>
    <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">Create the responsive visual layout everyone uses. You control the questions and presentation; Hized resolves approved KPI values separately for each viewer’s permitted organisation scope.</p>
    <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_22rem]">
      <section className="space-y-3">
        {views.length ? views.map((view) => <Link key={view.id} href={href(`/admin/dashboards/${view.id}`)} className="block rounded-xl border border-line bg-panel p-5 shadow-sm hover:border-teal-deep"><div className="flex items-start justify-between gap-3"><div><h2 className="font-display text-lg font-semibold text-ink">{view.name}</h2><p className="mt-1 text-sm text-muted">{view.description || "No description yet."}</p></div>{view.isDefault && <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">Company default</span>}</div><p className="mt-4 text-xs capitalize text-muted">{view.widgetCount} visuals · {view.status}</p></Link>) : <div className="rounded-xl border border-dashed border-line bg-panel p-8 text-center text-sm text-muted">No configured Pulse view yet. Create the first company view.</div>}
      </section>
      <section className="h-fit rounded-xl border border-line bg-panel p-5"><h2 className="font-display text-xl font-semibold text-ink">New Pulse view</h2><p className="mt-2 text-sm leading-6 text-muted">Start as a private draft. Publishing makes it the company default.</p><form action={createAnalyticsViewAction} className="mt-4 space-y-4"><input type="hidden" name="surface" value="pulse"/><label className="block text-sm font-medium text-ink">Name<input name="name" required maxLength={120} className="mt-1 w-full rounded-md border border-line px-3 py-2" placeholder="Company performance"/></label><label className="block text-sm font-medium text-ink">Description<textarea name="description" maxLength={500} rows={3} className="mt-1 w-full rounded-md border border-line px-3 py-2" placeholder="The questions this view answers"/></label><button className="tenant-brand-primary rounded-md px-4 py-2 text-sm font-semibold">Create view</button></form></section>
    </div>
  </div>;
}
