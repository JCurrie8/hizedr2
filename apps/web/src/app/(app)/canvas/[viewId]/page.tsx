import { withUserContext } from "@hized/db";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AnalyticsViewEditor } from "@/components/visuals/AnalyticsViewEditor";
import { AnalyticsViewRenderer } from "@/components/visuals/AnalyticsViewRenderer";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listAnalyticsMetricOptions, loadAnalyticsViewRuntime } from "@/server/domains/analytics/visual-views";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

export default async function CanvasBoardPage({ params, searchParams }: { params: Promise<{ viewId: string }>; searchParams: Promise<{ org?: string }> }) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const [{ viewId }, query] = await Promise.all([params, searchParams]);
  const org = /^[0-9a-f-]{36}$/i.test(query.org ?? "") ? query.org : null;
  const [requestHeaders, result] = await Promise.all([headers(), withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => ({ runtime: await loadAnalyticsViewRuntime(client, { tenantId: ctx.tenant.id, viewId, requestedOrgNodeId: org }), metrics: await listAnalyticsMetricOptions(client, { tenantId: ctx.tenant.id }) }))]);
  if (!result.runtime || result.runtime.view.surface !== "canvas") notFound();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const href = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  if (result.runtime.view.canEdit) return <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12"><AnalyticsViewEditor surface="canvas" runtime={result.runtime} metrics={result.metrics} backHref={href("/canvas")}/></div>;
  return <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12"><Link href={href("/canvas")} className="text-sm font-semibold text-teal-deep hover:underline">← All Canvas boards</Link><p className="mt-5 font-mono text-xs uppercase tracking-[0.18em] text-teal-deep">Shared Canvas board</p><h1 className="mt-2 font-display text-3xl font-bold text-ink">{result.runtime.view.name}</h1><p className="mt-2 text-sm leading-6 text-muted">{result.runtime.view.description}</p>{result.runtime.hierarchy && <nav className="mt-4 flex flex-wrap gap-2" aria-label="Organisation drill down">{[result.runtime.hierarchy.selected, ...result.runtime.hierarchy.children].map((node) => <Link key={node.id} href={href(`/canvas/${viewId}?org=${node.id}`)} className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink hover:border-teal-deep">{node.name}</Link>)}</nav>}<div className="mt-6"><AnalyticsViewRenderer runtime={result.runtime}/></div></div>;
}
