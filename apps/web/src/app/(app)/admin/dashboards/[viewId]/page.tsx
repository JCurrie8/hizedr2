import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AnalyticsViewEditor } from "@/components/visuals/AnalyticsViewEditor";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listAnalyticsMetricOptions, loadAnalyticsViewRuntime } from "@/server/domains/analytics/visual-views";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

export default async function PulseViewEditorPage({ params }: { params: Promise<{ viewId: string }> }) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const { viewId } = await params;
  const [requestHeaders, result] = await Promise.all([
    headers(),
    withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => ({
      runtime: await loadAnalyticsViewRuntime(client, { tenantId: ctx.tenant.id, viewId }),
      metrics: await listAnalyticsMetricOptions(client, { tenantId: ctx.tenant.id }),
    })),
  ]);
  if (!result.runtime || result.runtime.view.surface !== "pulse" || !result.runtime.view.canEdit) notFound();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  return <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12"><AnalyticsViewEditor surface="pulse" runtime={result.runtime} metrics={result.metrics} backHref={tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/admin/dashboards" })}/></div>;
}
