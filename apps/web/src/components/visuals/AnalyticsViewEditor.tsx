import Link from "next/link";
import {
  addAnalyticsWidgetAction,
  duplicateAnalyticsViewAction,
  moveAnalyticsWidgetAction,
  publishAnalyticsViewAction,
  removeAnalyticsWidgetAction,
  resizeAnalyticsWidgetAction,
  updateAnalyticsViewAction,
} from "@/app/(app)/analytics-actions";
import type {
  AnalyticsMetricOption,
  AnalyticsSharingOptions,
  AnalyticsSurface,
  AnalyticsViewGrant,
  AnalyticsViewRuntime,
} from "@/server/domains/analytics/visual-views";
import { AnalyticsViewRenderer } from "./AnalyticsViewRenderer";
import { AnalyticsSharingPanel } from "./AnalyticsSharingPanel";

const VISUALS = [
  ["kpi", "KPI card", "A prominent current value, target and status."],
  ["line", "Line", "Change over time for one or more measures."],
  ["area", "Area", "Trend magnitude over time."],
  ["bar", "Column", "Compare measures or organisation areas."],
  ["horizontal_bar", "Horizontal bar", "Readable ranking for longer category names."],
  ["stacked_bar", "Target attainment", "Actual and remaining target contribution."],
  ["donut", "Donut", "Part-to-whole comparison at a point in time."],
  ["gauge", "Gauge", "Current value against its governed target."],
  ["funnel", "Funnel", "Ordered stages such as leads, opportunities and wins."],
  ["heatmap", "Heatmap", "Patterns across child areas and reporting periods."],
  ["table", "Data table", "Exact values, targets and variance."],
  ["text", "Text panel", "Headings, interpretation or report guidance."],
  ["combo", "Line + column", "Compare two measures across the same periods."],
  ["waterfall", "Waterfall", "Explain positive and negative contributions to change."],
  ["treemap", "Treemap", "Show proportional magnitude across areas or measures."],
  ["radar", "Radar", "Compare a multi-measure performance profile."],
  ["scatter", "Scatter", "Reveal the relationship between two measures across areas."],
  ["bullet", "Bullet", "A compact actual-versus-target performance bar."],
] as const;

const inputClass = "mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink";

export function AnalyticsViewEditor({
  surface,
  runtime,
  metrics,
  backHref,
  sharing,
}: {
  surface: AnalyticsSurface;
  runtime: AnalyticsViewRuntime;
  metrics: AnalyticsMetricOption[];
  backHref: string;
  sharing?: { grants: AnalyticsViewGrant[]; options: AnalyticsSharingOptions } | null;
}) {
  const { view } = runtime;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={backHref} className="text-sm font-semibold text-teal-deep hover:underline">← All {surface === "pulse" ? "Pulse views" : "Canvas boards"}</Link>
          <p className="mt-4 font-mono text-xs uppercase tracking-[0.18em] text-teal-deep">{surface} builder</p>
          <h1 className="mt-2 font-display text-3xl font-bold text-ink">{view.name}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
            {surface === "pulse"
              ? "Build the company’s published performance experience from governed KPIs. Every user sees the same layout with only the data their role and organisation scope permits."
              : "Compose a personal or shared analysis board without copying data or redefining KPIs. Viewers resolve every value through their own permissions."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {surface === "canvas" && (
            <form action={duplicateAnalyticsViewAction}>
              <input type="hidden" name="viewId" value={view.id} />
              <button className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink hover:border-teal-deep" type="submit">
                Duplicate board
              </button>
            </form>
          )}
          <form action={publishAnalyticsViewAction}>
            <input type="hidden" name="surface" value={surface} />
            <input type="hidden" name="viewId" value={view.id} />
            <button className="tenant-brand-primary rounded-md px-4 py-2 text-sm font-semibold" type="submit">
              {surface === "pulse" ? "Publish as company default" : "Publish board"}
            </button>
          </form>
        </div>
      </div>

      <section className="rounded-xl border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold text-ink">View settings</h2>
          <span className="rounded-full bg-canvas px-3 py-1 text-xs font-semibold capitalize text-muted">{view.status} · {view.visibility}</span>
        </div>
        <form action={updateAnalyticsViewAction} className="mt-4 grid gap-4 md:grid-cols-2">
          <input type="hidden" name="surface" value={surface} />
          <input type="hidden" name="viewId" value={view.id} />
          <label className="text-sm font-medium text-ink">Name<input className={inputClass} name="name" defaultValue={view.name} maxLength={120} required /></label>
          {surface === "canvas" && view.isOwner ? (
            <label className="text-sm font-medium text-ink">Who can open it
              <select key={view.visibility} className={inputClass} name="visibility" defaultValue={view.visibility}>
                <option value="private">Only me</option>
                <option value="tenant">Everyone in the company</option>
                <option value="restricted">Chosen people, roles or areas</option>
              </select>
            </label>
          ) : <input type="hidden" name="visibility" value={surface === "pulse" ? "tenant" : view.visibility} />}
          <label className="text-sm font-medium text-ink md:col-span-2">Description<textarea className={inputClass} name="description" defaultValue={view.description} maxLength={500} rows={2} /></label>
          <button type="submit" className="w-fit rounded-md border border-line bg-canvas px-4 py-2 text-sm font-semibold text-ink hover:border-teal-deep">Save settings</button>
        </form>
      </section>

      {surface === "canvas" && view.isOwner && sharing && (
        <AnalyticsSharingPanel
          viewId={view.id}
          status={view.status}
          grants={sharing.grants}
          options={sharing.options}
        />
      )}

      <section className="rounded-xl border border-line bg-panel p-5">
        <h2 className="font-display text-xl font-semibold text-ink">Add a visual</h2>
        <p className="mt-2 text-sm leading-6 text-muted">Choose the question first, then its display. Trend uses reporting periods; child comparison uses departments, teams or other visible areas beneath the current drill point.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {VISUALS.map(([key, label, description]) => <div key={key} className="rounded-lg border border-line bg-canvas p-3"><p className="text-sm font-semibold text-ink">{label}</p><p className="mt-1 text-xs leading-5 text-muted">{description}</p></div>)}
        </div>
        <form action={addAnalyticsWidgetAction} className="mt-6 grid gap-4 md:grid-cols-2">
          <input type="hidden" name="surface" value={surface} />
          <input type="hidden" name="viewId" value={view.id} />
          <label className="text-sm font-medium text-ink">Visual title<input className={inputClass} name="title" maxLength={120} required /></label>
          <label className="text-sm font-medium text-ink">Visual type<select className={inputClass} name="visualType" defaultValue="kpi">{VISUALS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="text-sm font-medium text-ink">Subtitle<input className={inputClass} name="subtitle" maxLength={240} /></label>
          <label className="text-sm font-medium text-ink">Data shape<select className={inputClass} name="sourceMode" defaultValue="current"><option value="current">Current selected area</option><option value="children">Compare visible child areas</option><option value="trend">Trend for selected area</option></select></label>
          <label className="text-sm font-medium text-ink">Width<select className={inputClass} name="width" defaultValue="6"><option value="3">Quarter</option><option value="4">Third</option><option value="6">Half</option><option value="8">Two thirds</option><option value="12">Full width</option></select></label>
          <label className="text-sm font-medium text-ink">Height<select className={inputClass} name="height" defaultValue="standard"><option value="compact">Compact</option><option value="standard">Standard</option><option value="tall">Tall</option></select></label>
          <fieldset className="rounded-lg border border-line p-4 md:col-span-2">
            <legend className="px-2 text-sm font-semibold text-ink">Governed KPIs</legend>
            {metrics.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{metrics.map((metric) => <label key={metric.id} className="flex items-start gap-2 text-sm text-ink"><input type="checkbox" name="metricIds" value={metric.id} className="mt-1" /><span><span className="font-semibold">{metric.name}</span><span className="mt-0.5 block text-xs leading-5 text-muted">{metric.definition}</span></span></label>)}</div> : <p className="text-sm text-muted">No approved KPIs are available yet. An Admin or Analyst can prepare them in the KPI catalogue.</p>}
          </fieldset>
          <label className="text-sm font-medium text-ink md:col-span-2">Text panel content <span className="font-normal text-muted">(only used for Text)</span><textarea className={inputClass} name="staticText" maxLength={3000} rows={3} /></label>
          <button type="submit" className="tenant-brand-primary w-fit rounded-md px-4 py-2 text-sm font-semibold">Add visual</button>
        </form>
      </section>

      <section>
        <div className="flex items-end justify-between gap-3">
          <div><p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Live governed preview</p><h2 className="mt-1 font-display text-2xl font-semibold text-ink">What viewers will see</h2></div>
          <p className="text-xs text-muted">{view.widgets.length} visual{view.widgets.length === 1 ? "" : "s"}</p>
        </div>
        <div className="mt-4"><AnalyticsViewRenderer runtime={runtime} /></div>
        {view.widgets.length > 0 && <div className="mt-5 space-y-2">{view.widgets.map((widget, index) => (
          <div key={widget.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 text-sm">
            <span className="min-w-48 flex-1 font-semibold text-ink">{index + 1}. {widget.title} <span className="font-normal capitalize text-muted">· {widget.visualType.replaceAll("_", " ")}</span></span>
            <form action={moveAnalyticsWidgetAction}><input type="hidden" name="surface" value={surface}/><input type="hidden" name="viewId" value={view.id}/><input type="hidden" name="widgetId" value={widget.id}/><input type="hidden" name="direction" value="up"/><button disabled={index === 0} className="rounded border border-line px-2.5 py-1.5 font-semibold disabled:opacity-30">↑</button></form>
            <form action={moveAnalyticsWidgetAction}><input type="hidden" name="surface" value={surface}/><input type="hidden" name="viewId" value={view.id}/><input type="hidden" name="widgetId" value={widget.id}/><input type="hidden" name="direction" value="down"/><button disabled={index === view.widgets.length - 1} className="rounded border border-line px-2.5 py-1.5 font-semibold disabled:opacity-30">↓</button></form>
            <form action={resizeAnalyticsWidgetAction} className="flex items-center gap-2"><input type="hidden" name="surface" value={surface}/><input type="hidden" name="viewId" value={view.id}/><input type="hidden" name="widgetId" value={widget.id}/><select name="width" defaultValue={widget.width} className="rounded border border-line bg-panel px-2 py-1.5"><option value="3">¼</option><option value="4">⅓</option><option value="6">½</option><option value="8">⅔</option><option value="12">Full</option></select><button className="rounded border border-line px-2.5 py-1.5 font-semibold">Resize</button></form>
            <form action={removeAnalyticsWidgetAction}><input type="hidden" name="surface" value={surface}/><input type="hidden" name="viewId" value={view.id}/><input type="hidden" name="widgetId" value={widget.id}/><button className="rounded border border-danger/30 px-2.5 py-1.5 font-semibold text-danger">Remove</button></form>
          </div>
        ))}</div>}
      </section>
    </div>
  );
}
