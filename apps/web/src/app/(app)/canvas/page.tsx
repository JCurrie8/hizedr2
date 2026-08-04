import { withUserContext } from "@hized/db";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAnalyticsViewAction } from "@/app/(app)/analytics-actions";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listAnalyticsViews } from "@/server/domains/analytics/visual-views";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

export default async function CanvasPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const [requestHeaders, result] = await Promise.all([
    headers(),
    withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => ({ allowed: await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "canvas" }), views: await listAnalyticsViews(client, { tenantId: ctx.tenant.id, surface: "canvas" }) })),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const href = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  if (!result.allowed) redirect(href("/home"));
  return <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
    <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Canvas</p><h1 className="mt-2 font-display text-3xl font-bold text-ink">Analysis boards</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-muted">Build a board for a meeting, role or business question using the same governed definitions as Pulse. A shared layout adapts to each viewer’s data permissions.</p>
    <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_22rem]"><section className="grid gap-4 sm:grid-cols-2">{result.views.length ? result.views.map((view) => <Link key={view.id} href={href(`/canvas/${view.id}`)} className="rounded-xl border border-line bg-panel p-5 shadow-sm hover:border-teal-deep"><div className="flex justify-between gap-3"><h2 className="font-display text-lg font-semibold text-ink">{view.name}</h2><span className="rounded-full bg-canvas px-2 py-1 text-[10px] font-semibold uppercase text-muted">{view.visibility}</span></div><p className="mt-2 text-sm leading-6 text-muted">{view.description || "No description yet."}</p><p className="mt-5 text-xs capitalize text-muted">{view.widgetCount} visuals · {view.status}{view.isOwner ? " · yours" : ""}</p></Link>) : <div className="rounded-xl border border-dashed border-line bg-panel p-8 text-center text-sm text-muted sm:col-span-2">No boards are visible yet. Create your first governed analysis.</div>}</section>
    <section className="h-fit rounded-xl border border-line bg-panel p-5"><h2 className="font-display text-xl font-semibold text-ink">New board</h2><p className="mt-2 text-sm leading-6 text-muted">Every active user can start privately and choose whether to share later.</p><form action={createAnalyticsViewAction} className="mt-4 space-y-4"><input type="hidden" name="surface" value="canvas"/><label className="block text-sm font-medium text-ink">Name<input name="name" required maxLength={120} className="mt-1 w-full rounded-md border border-line px-3 py-2" placeholder="Weekly operations review"/></label><label className="block text-sm font-medium text-ink">Description<textarea name="description" maxLength={500} rows={3} className="mt-1 w-full rounded-md border border-line px-3 py-2" placeholder="The decision this board supports"/></label><button className="tenant-brand-primary rounded-md px-4 py-2 text-sm font-semibold">Create board</button></form></section></div>
  </div>;
}
