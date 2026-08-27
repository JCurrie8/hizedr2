import { withUserContext } from "@hized/db";
import Link from "next/link";
import { headers } from "next/headers";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listSqlAnalyses } from "@/server/domains/analytics/sql-analysis";
import { listSqlServerConnectors } from "@/server/domains/connectors/sql-server-connectors";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { certifySqlAnalysisAction, createSqlAnalysisAction, runSqlAnalysisAction } from "./actions";

const inputClass = "mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink";

export default async function SqlQueriesPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    return <div className="mx-auto w-full max-w-4xl px-6 py-10"><h1 className="font-display text-2xl font-bold text-ink">SQL analysis is restricted</h1><p className="mt-3 text-sm text-muted">A Company Admin or Analyst can author bounded queries against an approved read-only connection.</p></div>;
  }
  const [requestHeaders, data] = await Promise.all([
    headers(),
    withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
      await assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" });
      return {
        connectors: await listSqlServerConnectors(client, { tenantId: ctx.tenant.id }),
        queries: await listSqlAnalyses(client, { tenantId: ctx.tenant.id }),
      };
    }),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const href = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });

  return <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">SQL visual studio</p>
        <h1 className="mt-2 font-display text-3xl font-bold text-ink">Build once, visualise, then certify</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">Run a bounded SELECT against an approved read-only SQL Server or Azure SQL connection. The result contract resolves every row to the Hized organisation hierarchy, so Canvas and Pulse never inherit the database login&apos;s broader visibility.</p>
      </div>
      <div className="flex gap-2"><Link href={href("/canvas")} className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink">Canvas</Link><Link href={href("/admin/dashboards")} className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink">Pulse views</Link></div>
    </div>

    <div className="mt-8 grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
      <section className="h-fit rounded-xl border border-line bg-panel p-5">
        <h2 className="font-display text-xl font-semibold text-ink">New SQL analysis</h2>
        <p className="mt-2 text-sm leading-6 text-muted">Only one SELECT/CTE statement is accepted. Comments, write verbs and dynamic/external execution are refused; execution stops at 5,000 rows and 30 seconds.</p>
        {data.connectors.length > 0 ? <form action={createSqlAnalysisAction} className="mt-5 space-y-4">
          <label className="block text-sm font-medium text-ink">Read-only connection<select className={inputClass} name="connectorId" required defaultValue=""><option value="" disabled>Choose connection</option>{data.connectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name} · {connector.database}</option>)}</select></label>
          <label className="block text-sm font-medium text-ink">Analysis name<input className={inputClass} name="name" required maxLength={120} placeholder="Weekly installation throughput" /></label>
          <label className="block text-sm font-medium text-ink">Description<textarea className={inputClass} name="description" maxLength={1000} rows={2} placeholder="The business question and intended audience" /></label>
          <label className="block text-sm font-medium text-ink">SQL query<textarea className={`${inputClass} font-mono text-xs leading-5`} name="sqlText" required maxLength={50000} rows={18} spellCheck={false} placeholder={`select\n  TeamCode as org_code,\n  'jobs_completed' as series_key,\n  'Jobs completed' as series_label,\n  datefromparts(year(CompletedAt), month(CompletedAt), 1) as period_start,\n  dateadd(month, 1, datefromparts(year(CompletedAt), month(CompletedAt), 1)) as period_end,\n  count_big(*) as actual_value,\n  max(UpdatedAt) as source_refreshed_at\nfrom curated.Jobs\ngroup by TeamCode, datefromparts(year(CompletedAt), month(CompletedAt), 1)`} /></label>
          <div className="rounded-lg border border-line bg-canvas p-4 text-xs leading-5 text-muted"><strong className="text-ink">Required aliases:</strong> org_code or org_node_id, series_key, series_label, period_start, period_end, actual_value. <strong className="text-ink">Optional:</strong> category_label, target_value, prior_period_value, numerator_value, denominator_value, source_refreshed_at.</div>
          <button className="tenant-brand-primary rounded-md px-4 py-2 text-sm font-semibold">Save and run query</button>
        </form> : <div className="mt-5 rounded-lg border border-dashed border-line bg-canvas p-5 text-sm leading-6 text-muted">Add and test a read-only SQL Server/Azure SQL source in <Link href={href("/admin/connect")} className="font-semibold text-teal-deep underline">Connect</Link> first. Loader credentials are deliberately excluded.</div>}
      </section>

      <section className="space-y-4">
        {data.queries.length > 0 ? data.queries.map((query) => <article key={query.id} className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-semibold text-ink">{query.name}</h2><p className="mt-1 text-sm text-muted">{query.description || "No description."}</p><p className="mt-2 text-xs text-muted">{query.connectorName} · {query.lastRowCount ?? 0} rows{query.lastRunAt ? ` · ${new Date(query.lastRunAt).toLocaleString("en-GB")}` : ""}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${query.lastRunStatus === "failed" ? "bg-red-50 text-danger" : query.status === "certified" ? "bg-emerald-50 text-emerald-800" : "bg-canvas text-muted"}`}>{query.lastRunStatus === "failed" ? "failed" : query.status}</span></div>
          {query.lastRunMessage && <p className={`mt-3 rounded border px-3 py-2 text-xs ${query.lastRunStatus === "failed" ? "border-red-200 bg-red-50 text-danger" : "border-line bg-canvas text-muted"}`}>{query.lastRunMessage}</p>}
          <div className="mt-4 flex flex-wrap gap-2"><form action={runSqlAnalysisAction}><input type="hidden" name="queryId" value={query.id}/><button className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink">Run now</button></form><span className="self-center text-xs text-muted">Add this analysis as a visual data source in either builder.</span></div>
          {query.series.length > 0 && <div className="mt-5 space-y-4">{query.series.map((series) => <div key={series.key} className="rounded-lg border border-line bg-canvas p-4">
            <div className="flex flex-wrap justify-between gap-2"><div><p className="font-semibold text-ink">{series.label}</p><p className="font-mono text-xs text-muted">{series.key} · {series.rowCount} scoped rows</p></div>{series.certifiedKpiId && <span className="h-fit rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">Certified Pulse metric</span>}</div>
            {ctx.role === "company_admin" && !series.certifiedKpiId && <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-teal-deep">Certify as Pulse metric</summary><form action={certifySqlAnalysisAction} className="mt-4 grid gap-3 md:grid-cols-2"><input type="hidden" name="queryId" value={query.id}/><input type="hidden" name="seriesKey" value={series.key}/><label className="text-xs font-medium text-ink">Metric key<input className={inputClass} name="kpiKey" required pattern="[a-z][a-z0-9_]*" defaultValue={series.key}/></label><label className="text-xs font-medium text-ink">Metric name<input className={inputClass} name="metricName" required maxLength={120} defaultValue={series.label}/></label><label className="text-xs font-medium text-ink md:col-span-2">Definition<textarea className={inputClass} name="definition" required maxLength={1200} rows={2}/></label><label className="text-xs font-medium text-ink md:col-span-2">Business purpose<textarea className={inputClass} name="businessPurpose" required maxLength={1200} rows={2}/></label><label className="text-xs font-medium text-ink">Business owner<input className={inputClass} name="ownerName" required maxLength={120}/></label><label className="text-xs font-medium text-ink">Unit<select className={inputClass} name="unit" defaultValue="number"><option value="number">Number</option><option value="percentage">Percentage</option><option value="currency">Currency</option><option value="duration">Duration</option><option value="score">Score</option></select></label><label className="text-xs font-medium text-ink">Currency code (currency only)<input className={inputClass} name="currencyCode" maxLength={3} defaultValue="GBP"/></label><label className="text-xs font-medium text-ink">Decimal places<input className={inputClass} type="number" name="decimalPlaces" min={0} max={6} defaultValue={0}/></label><label className="text-xs font-medium text-ink">Favourable direction<select className={inputClass} name="favourableDirection"><option value="higher">Higher</option><option value="lower">Lower</option><option value="target">On target</option></select></label><label className="text-xs font-medium text-ink">Aggregation<select className={inputClass} name="aggregation"><option value="sum">Sum</option><option value="average">Average</option><option value="distinct_count">Distinct count</option><option value="ratio">Ratio</option><option value="snapshot">Snapshot</option><option value="semi_additive">Semi-additive</option></select></label><fieldset className="md:col-span-2"><legend className="text-xs font-semibold text-ink">Audience</legend><div className="mt-2 flex flex-wrap gap-3">{[["company_admin","Company Admin"],["analyst","Analyst"],["manager","Manager"],["employee","End user"]].map(([value,label]) => <label key={value} className="text-xs text-ink"><input type="checkbox" name="audienceRoles" value={value} defaultChecked className="mr-1"/>{label}</label>)}</div></fieldset><button className="tenant-brand-primary w-fit rounded-md px-4 py-2 text-sm font-semibold md:col-span-2">Certify metric</button></form></details>}
          </div>)}</div>}
        </article>) : <div className="rounded-xl border border-dashed border-line bg-panel p-8 text-center text-sm text-muted">No saved SQL analyses yet.</div>}
      </section>
    </div>
  </div>;
}
