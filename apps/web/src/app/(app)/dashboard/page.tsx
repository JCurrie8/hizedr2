import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import Link from "next/link";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { getPulseHomeSnapshot } from "@/server/domains/pulse/home";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

function formatDateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

export default async function DashboardPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null; // layout already redirects/handles other cases

  const includeConnectHealth = ctx.role === "company_admin" || ctx.role === "analyst";
  const [requestHeaders, snapshot] = await Promise.all([
    headers(),
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => getPulseHomeSnapshot(client, { tenantId: ctx.tenant.id, includeConnectHealth }),
    ),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  const firstName = ctx.fullName?.trim().split(/\s+/)[0] ?? null;
  const connect = snapshot.connect;
  const hasCompletedRun = connect?.recentRuns.some((run) => run.status === "succeeded" || run.status === "warning") ?? false;
  const attentionCount = (connect?.failedRuns ?? 0) + (connect?.warningRuns ?? 0);

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

      <section className={`mt-7 rounded-xl border p-4 sm:p-5 ${attentionCount > 0 ? "border-warning/40 bg-amber-50" : "border-line bg-panel"}`}>
        <div className="flex gap-3">
          <span aria-hidden="true" className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${attentionCount > 0 ? "bg-warning" : hasCompletedRun ? "bg-success" : "bg-teal"}`} />
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              {attentionCount > 0
                ? `${attentionCount} recent data run${attentionCount === 1 ? " needs" : "s need"} attention`
                : hasCompletedRun
                  ? "Your data foundation is refreshing"
                  : "Your performance workspace is ready to configure"}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              {connect?.latestRunAt
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
          [includeConnectHealth ? "Pipelines" : "KPI catalogue", includeConnectHealth ? String(connect?.pipelineCount ?? 0) : "—", includeConnectHealth ? "configured data flows" : "awaiting publication"],
        ].map(([label, value, hint]) => (
          <article key={label} className="rounded-xl border border-line bg-panel p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
            <p className="mt-3 font-display text-3xl font-bold text-ink">{value}</p>
            <p className="mt-1 text-xs leading-5 text-muted">{hint}</p>
          </article>
        ))}
      </section>

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
                complete: false,
                href: null,
                action: "Next build slice",
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

        <aside className="rounded-xl bg-navy p-5 text-white sm:p-6">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal">Data confidence</p>
          <h2 className="mt-2 font-display text-xl font-semibold">Know what sits behind every number</h2>
          {includeConnectHealth ? (
            <dl className="mt-6 space-y-4">
              <div className="flex items-end justify-between gap-4 border-b border-white/15 pb-3">
                <dt className="text-sm text-white/70">Configured sources</dt>
                <dd className="font-display text-2xl font-bold">{connect?.connectors.length ?? 0}</dd>
              </div>
              <div className="flex items-end justify-between gap-4 border-b border-white/15 pb-3">
                <dt className="text-sm text-white/70">Recent rows accepted</dt>
                <dd className="font-display text-2xl font-bold">{(connect?.recentRowsAccepted ?? 0).toLocaleString("en-GB")}</dd>
              </div>
              <div className="flex items-end justify-between gap-4">
                <dt className="text-sm text-white/70">Runs needing attention</dt>
                <dd className="font-display text-2xl font-bold">{attentionCount}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-5 text-sm leading-6 text-white/75">
              Freshness, definitions and lineage will travel with every KPI. Your role only receives approved performance views—not connector credentials or raw pipeline controls.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
