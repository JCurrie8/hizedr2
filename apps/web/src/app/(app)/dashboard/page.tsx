import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import Link from "next/link";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { getPulseHomeSnapshot } from "@/server/domains/pulse/home";
import {
  thresholdState,
  trendDirection,
  type KpiThresholdState,
  type PulseKpiCard,
} from "@/server/domains/pulse/kpis";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { redirect } from "next/navigation";
import { AnalyticsViewRenderer } from "@/components/visuals/AnalyticsViewRenderer";
import { getDefaultPulseView, loadAnalyticsViewRuntime } from "@/server/domains/analytics/visual-views";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatDateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

function formatKpiValue(kpi: PulseKpiCard, value: number): string {
  if (kpi.unit === "percentage") return `${value.toFixed(kpi.decimalPlaces)}%`;
  if (kpi.unit === "currency") {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: kpi.currencyCode ?? "GBP",
      maximumFractionDigits: kpi.decimalPlaces,
    }).format(value);
  }
  return new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: kpi.decimalPlaces,
    maximumFractionDigits: kpi.decimalPlaces,
  }).format(value);
}

function formatPeriod(end: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${end}T00:00:00Z`));
}

function thresholdPresentation(state: KpiThresholdState) {
  if (state === "green") return { label: "On track", classes: "bg-emerald-100 text-emerald-900", dot: "bg-success" };
  if (state === "amber") return { label: "Watch", classes: "bg-amber-100 text-amber-900", dot: "bg-warning" };
  if (state === "red") return { label: "Needs attention", classes: "bg-red-100 text-red-900", dot: "bg-danger" };
  return { label: "No threshold", classes: "bg-canvas text-muted", dot: "bg-muted" };
}

function TrendSparkline({ kpi }: { kpi: PulseKpiCard }) {
  if (kpi.trend.length < 2) return <p className="text-xs text-muted">More periods needed for a trend</p>;
  const width = 180;
  const height = 52;
  const padding = 4;
  const values = kpi.trend.map((point) => point.actualValue);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum || 1;
  const points = values.map((value, index) => {
    const x = padding + (index / (values.length - 1)) * (width - padding * 2);
    const y = height - padding - ((value - minimum) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const direction = trendDirection(kpi);
  const lineColour = direction === "deteriorating" ? "#D64545" : direction === "improving" ? "#0E7C80" : "#5B6B76";
  const directionLabel = direction === "no_comparison" ? "No comparison" : direction[0].toUpperCase() + direction.slice(1);

  return (
    <div>
      <svg
        role="img"
        aria-label={`${kpi.name} trend: ${directionLabel.toLowerCase()}`}
        viewBox={`0 0 ${width} ${height}`}
        className="h-14 w-full"
        preserveAspectRatio="none"
      >
        <polyline points={points} fill="none" stroke={lineColour} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="mt-1 flex items-center justify-between gap-3 text-xs">
        <span className={direction === "deteriorating" ? "font-semibold text-danger" : direction === "improving" ? "font-semibold text-teal-deep" : "text-muted"}>
          {directionLabel}
        </span>
        {kpi.priorPeriodValue !== null && <span className="text-muted">Prior {formatKpiValue(kpi, kpi.priorPeriodValue)}</span>}
      </div>
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null; // layout already redirects/handles other cases

  const requestedOrg = (await searchParams).org;
  const requestedOrgNodeId = requestedOrg && UUID_PATTERN.test(requestedOrg) ? requestedOrg : null;

  const includeConnectHealth = ctx.role === "company_admin" || ctx.role === "analyst";
  const [requestHeaders, pulseResult] = await Promise.all([
    headers(),
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" })) return null;
        const snapshot = await getPulseHomeSnapshot(client, { tenantId: ctx.tenant.id, includeConnectHealth, requestedOrgNodeId });
        const defaultView = await getDefaultPulseView(client, { tenantId: ctx.tenant.id });
        const configuredView = defaultView
          ? await loadAnalyticsViewRuntime(client, { tenantId: ctx.tenant.id, viewId: defaultView.id, requestedOrgNodeId })
          : null;
        return { snapshot, configuredView };
      },
    ),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  if (!pulseResult) redirect(tenantHref("/home"));
  const { snapshot, configuredView } = pulseResult;
  const firstName = ctx.fullName?.trim().split(/\s+/)[0] ?? null;
  const connect = snapshot.connect;
  const kpis = snapshot.kpis;
  const hierarchy = snapshot.hierarchy;
  const hasCompletedRun = connect?.recentRuns.some((run) => run.status === "succeeded" || run.status === "warning") ?? false;
  const kpisNeedingAttention = kpis.filter((kpi) => ["amber", "red"].includes(thresholdState(kpi)) || kpi.freshness.status === "stale");
  const attentionCount = (connect?.failedRuns ?? 0) + (connect?.warningRuns ?? 0) + kpisNeedingAttention.length;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Company pulse</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Welcome{firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            One place to understand performance, data confidence and the areas that need attention across {ctx.tenant.name}.
          </p>
        </div>
        <div className="self-start rounded-full border border-line bg-panel px-3 py-1.5 text-xs capitalize text-muted sm:self-auto">
          {ctx.role.replaceAll("_", " ")} view
        </div>
      </div>

      {hierarchy && (
        <nav aria-label="Organisation drill path" className="mt-5 flex flex-wrap items-center gap-2 text-sm">
          {hierarchy.breadcrumbs.map((node, index) => {
            const isCurrent = node.id === hierarchy.selected.id;
            return (
              <div key={node.id} className="flex items-center gap-2">
                {index > 0 && <span aria-hidden="true" className="text-muted">/</span>}
                {isCurrent
                  ? <span aria-current="page" className="font-semibold text-ink">{node.name}</span>
                  : <Link href={tenantHref(`/dashboard?org=${encodeURIComponent(node.id)}`)} className="font-medium text-teal-deep hover:underline">{node.name}</Link>}
              </div>
            );
          })}
        </nav>
      )}

      <section className={`mt-7 rounded-xl border p-4 sm:p-5 ${attentionCount > 0 ? "border-warning/40 bg-amber-50" : "border-line bg-panel"}`}>
        <div className="flex gap-3">
          <span aria-hidden="true" className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${attentionCount > 0 ? "bg-warning" : hasCompletedRun ? "bg-success" : "bg-teal"}`} />
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              {attentionCount > 0
                ? `${attentionCount} performance or data item${attentionCount === 1 ? " needs" : "s need"} attention`
                : kpis.length > 0
                  ? "Performance is on track and the supporting data is fresh"
                  : hasCompletedRun
                  ? "Your data foundation is refreshing"
                  : "Your performance workspace is ready to configure"}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              {kpis.length > 0
                ? `${kpis.length} governed KPI${kpis.length === 1 ? " is" : "s are"} published for ${hierarchy?.selected.name ?? kpis[0]?.organisation.name ?? "your scope"}. Every number retains its definition, threshold, target, trend, owner and freshness.`
                : connect?.latestRunAt
                ? `Latest observed pipeline activity: ${formatDateTime(connect.latestRunAt, ctx.tenant.timezone)}.`
                : includeConnectHealth
                  ? "Connect the first operational source, then publish governed KPIs into this Pulse view."
                  : "Governed KPIs and source freshness will appear here when your reporting model is published."}
            </p>
          </div>
        </div>
      </section>

      <section aria-label="Workspace summary" className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Visible structure", snapshot.organisation.visibleNodes.toLocaleString("en-GB"), "organisation nodes in your scope"],
          ["Teams", snapshot.organisation.teams.toLocaleString("en-GB"), "available for drill-down"],
          ["People", snapshot.organisation.employees.toLocaleString("en-GB"), "employee nodes in scope"],
          ["Published KPIs", kpis.length.toLocaleString("en-GB"), kpis.length ? "at your landing scope" : "awaiting publication"],
        ].map(([label, value, hint]) => (
          <article key={label} className="rounded-xl border border-line bg-panel p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
            <p className="mt-3 font-display text-3xl font-bold text-ink">{value}</p>
            <p className="mt-1 text-xs leading-5 text-muted">{hint}</p>
          </article>
        ))}
      </section>

      {configuredView && (
        <section aria-labelledby="configured-pulse-heading" className="mt-7">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Configured company view</p>
              <h2 id="configured-pulse-heading" className="mt-1 font-display text-2xl font-semibold text-ink">{configuredView.view.name}</h2>
            </div>
            {(ctx.role === "company_admin" || ctx.role === "analyst") && <Link href={tenantHref(`/admin/dashboards/${configuredView.view.id}`)} className="rounded-md border border-line bg-panel px-3 py-2 text-sm font-semibold text-ink hover:border-teal-deep">Configure Pulse</Link>}
          </div>
          <AnalyticsViewRenderer runtime={configuredView} />
        </section>
      )}

      {hierarchy && !configuredView && (
        <section aria-labelledby="performance-heading" className="mt-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Governed performance</p>
              <h2 id="performance-heading" className="mt-1 font-display text-2xl font-semibold text-ink">
                {hierarchy.selected.name}
              </h2>
            </div>
            <p className="text-xs capitalize text-muted">{hierarchy.selected.nodeType.replaceAll("_", " ")} · latest approved period per KPI</p>
          </div>
          {kpis.length > 0 ? <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {kpis.map((kpi) => {
              const state = thresholdState(kpi);
              const presentation = thresholdPresentation(state);
              const variance = kpi.targetValue === null ? null : kpi.actualValue - kpi.targetValue;
              return (
                <article key={kpi.definitionId} className="rounded-xl border border-line bg-panel p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-display text-lg font-semibold text-ink">{kpi.name}</h3>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{kpi.definition}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${presentation.classes}`}>
                      {presentation.label}
                    </span>
                  </div>
                  <div className="mt-5 flex items-end justify-between gap-4">
                    <p className="font-display text-4xl font-bold tracking-tight text-ink">{formatKpiValue(kpi, kpi.actualValue)}</p>
                    {variance !== null && (
                      <p className={`pb-1 text-right text-sm font-semibold ${state === "red" || state === "amber" ? "text-danger" : "text-teal-deep"}`}>
                        {variance > 0 ? "+" : ""}{formatKpiValue(kpi, variance)} vs target
                      </p>
                    )}
                  </div>
                  <div className="mt-4 rounded-lg bg-canvas px-3 py-2">
                    <TrendSparkline kpi={kpi} />
                  </div>
                  <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-xs">
                    <div>
                      <dt className="text-muted">Target</dt>
                      <dd className="mt-1 font-semibold text-ink">{kpi.targetValue === null ? "Not set" : formatKpiValue(kpi, kpi.targetValue)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Threshold</dt>
                      <dd className="mt-1 flex items-center gap-2 font-semibold text-ink"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${presentation.dot}`} />{presentation.label}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Period ending</dt>
                      <dd className="mt-1 font-semibold text-ink">{formatPeriod(kpi.periodEnd)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Owner</dt>
                      <dd className="mt-1 font-semibold text-ink">{kpi.ownerName}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Freshness</dt>
                      <dd className={`mt-1 font-semibold ${kpi.freshness.status === "stale" ? "text-danger" : "text-teal-deep"}`}>
                        {kpi.freshness.status === "stale" ? "Stale" : "Fresh"}
                      </dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div> : (
            <div className="mt-4 rounded-xl border border-dashed border-line bg-panel p-6">
              <h3 className="font-display text-lg font-semibold text-ink">No KPI values published at this level</h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Continue into a child area below, or publish a governed value for {hierarchy.selected.name}. Pulse never substitutes a parent number for a missing team or employee result.</p>
            </div>
          )}
        </section>
      )}

      {hierarchy && hierarchy.children.length > 0 && (
        <section aria-labelledby="drill-heading" className="mt-5 rounded-xl border border-line bg-panel p-5 sm:p-6">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Organisation drill-down</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="drill-heading" className="font-display text-2xl font-semibold text-ink">Explore the next level</h2>
              <p className="mt-1 text-sm text-muted">Only areas inside your permitted organisation scope are available.</p>
            </div>
            <span className="text-xs text-muted">{hierarchy.children.length} direct area{hierarchy.children.length === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hierarchy.children.map((child) => (
              <Link
                key={child.id}
                href={tenantHref(`/dashboard?org=${encodeURIComponent(child.id)}`)}
                className="group rounded-lg border border-line bg-canvas p-4 transition hover:border-teal hover:bg-white"
              >
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{child.nodeType.replaceAll("_", " ")}</span>
                <span className="mt-2 flex items-center justify-between gap-3 font-display text-lg font-semibold text-ink">
                  {child.name}<span aria-hidden="true" className="text-teal-deep transition group-hover:translate-x-1">→</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        <section className="rounded-xl border border-line bg-panel p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Getting to live performance</p>
              <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Build the first company scorecard</h2>
            </div>
            <span className="rounded-full bg-canvas px-3 py-1 text-xs font-medium text-muted">Pulse setup</span>
          </div>
          <ol className="mt-6 space-y-4">
            {[
              {
                title: "Organisation structure",
                description: "Define the company-to-team hierarchy used for role-aware drill-down.",
                complete: snapshot.organisation.visibleNodes > 0,
                href: tenantHref("/admin/organisation"),
                action: "Review structure",
              },
              {
                title: "Trusted source data",
                description: "Load and monitor the operational data that will support each measure.",
                complete: hasCompletedRun,
                href: includeConnectHealth ? tenantHref("/admin/connect") : null,
                action: connect?.pipelineCount ? "Review pipelines" : "Connect a source",
              },
              {
                title: "Governed KPIs",
                description: "Agree definitions, owners, targets and thresholds once, then reuse them across Pulse.",
                complete: kpis.length > 0,
                href: includeConnectHealth ? tenantHref("/admin/kpis") : null,
                action: kpis.length > 0 ? "Review catalogue" : "Set up catalogue",
              },
            ].map((step, index) => (
              <li key={step.title} className="flex gap-4 border-b border-line pb-4 last:border-b-0 last:pb-0">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${step.complete ? "bg-success text-white" : "bg-canvas text-muted"}`}>
                  {step.complete ? "✓" : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold text-ink">{step.title}</h3>
                    {step.href
                      ? <Link href={step.href} className="text-sm font-semibold text-teal-deep hover:underline">{step.action}</Link>
                      : <span className="text-xs font-medium uppercase tracking-wide text-muted">{step.action}</span>}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted">{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <aside className="tenant-brand-primary rounded-xl p-5 sm:p-6">
          <p className="font-mono text-xs uppercase tracking-[0.16em] opacity-75">Data confidence</p>
          <h2 className="mt-2 font-display text-xl font-semibold">Know what sits behind every number</h2>
          {includeConnectHealth ? (
            <dl className="mt-6 space-y-4">
              <div className="flex items-end justify-between gap-4 border-b border-white/15 pb-3">
                <dt className="text-sm opacity-70">Configured sources</dt>
                <dd className="font-display text-2xl font-bold">{connect?.connectors.length ?? 0}</dd>
              </div>
              <div className="flex items-end justify-between gap-4 border-b border-white/15 pb-3">
                <dt className="text-sm opacity-70">Recent rows accepted</dt>
                <dd className="font-display text-2xl font-bold">{(connect?.recentRowsAccepted ?? 0).toLocaleString("en-GB")}</dd>
              </div>
              <div className="flex items-end justify-between gap-4">
                <dt className="text-sm opacity-70">Runs needing attention</dt>
                <dd className="font-display text-2xl font-bold">{attentionCount}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-5 text-sm leading-6 opacity-75">
              Freshness, definitions and lineage will travel with every KPI. Your role only receives approved performance views—not connector credentials or raw pipeline controls.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
