import type {
  AnalyticsMetricReference,
  AnalyticsValuePoint,
  AnalyticsViewRuntime,
  AnalyticsWidgetDefinition,
} from "@/server/domains/analytics/visual-views";
import { thresholdState } from "@/server/domains/pulse/kpis";

const PALETTE = ["#0E7C80", "#0F2A43", "#E0A52B", "#D64545", "#678C93", "#7C5CA8", "#2D8B57", "#C66A2B"];
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const WIDTH_CLASSES: Record<number, string> = {
  3: "md:col-span-3",
  4: "md:col-span-4",
  5: "md:col-span-5",
  6: "md:col-span-6",
  7: "md:col-span-7",
  8: "md:col-span-8",
  9: "md:col-span-9",
  10: "md:col-span-10",
  11: "md:col-span-11",
  12: "md:col-span-12",
};

function formatValue(metric: AnalyticsMetricReference | undefined, value: number): string {
  if (!metric) return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);
  if (metric.unit === "percentage") return `${value.toFixed(metric.decimalPlaces)}%`;
  if (metric.unit === "currency") {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: metric.currencyCode ?? "GBP",
      maximumFractionDigits: metric.decimalPlaces,
    }).format(value);
  }
  return new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: metric.decimalPlaces,
    maximumFractionDigits: metric.decimalPlaces,
  }).format(value);
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}

function latestBy<T>(rows: T[], key: (row: T) => string, date: (row: T) => string): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const itemKey = key(row);
    const existing = latest.get(itemKey);
    if (!existing || date(existing) < date(row)) latest.set(itemKey, row);
  }
  return [...latest.values()];
}

function widgetValues(runtime: AnalyticsViewRuntime, widget: AnalyticsWidgetDefinition): AnalyticsValuePoint[] {
  const metricIds = new Set(widget.metrics.map((metric) => metric.id));
  const selectedId = runtime.hierarchy?.selected.id;
  if (!selectedId) return [];
  return runtime.values.filter((row) => {
    if (!metricIds.has(row.metricId)) return false;
    if (widget.sourceMode === "children") return row.organisationId !== selectedId;
    return row.organisationId === selectedId;
  });
}

function EmptyVisual({ message = "No permitted values are available for this visual." }: { message?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-line bg-canvas px-5 text-center text-sm leading-6 text-muted">
      {message}
    </div>
  );
}

function InspectDataTable({
  widget,
  rows,
}: {
  widget: AnalyticsWidgetDefinition;
  rows: AnalyticsValuePoint[];
}) {
  const sortedRows = [...rows].sort((left, right) =>
    left.metricName.localeCompare(right.metricName)
      || left.organisationName.localeCompare(right.organisationName)
      || right.periodEnd.localeCompare(left.periodEnd),
  );

  return (
    <details className="mt-5 border-t border-line pt-4">
      <summary className="cursor-pointer text-sm font-semibold text-teal-deep marker:text-muted">
        Inspect data · {sortedRows.length} permitted row{sortedRows.length === 1 ? "" : "s"}
      </summary>
      <p className="mt-2 text-xs leading-5 text-muted">
        Exact aggregate values behind this visual. Organisation scope and KPI permissions are applied before these rows reach the page.
      </p>
      {sortedRows.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[760px] text-left text-xs">
            <caption className="sr-only">Permitted aggregate data behind {widget.title}</caption>
            <thead>
              <tr className="border-b border-line bg-canvas uppercase tracking-wide text-muted">
                <th className="px-3 py-2.5">Measure</th>
                <th className="px-3 py-2.5">Area</th>
                <th className="px-3 py-2.5">Period ending</th>
                <th className="px-3 py-2.5 text-right">Actual</th>
                <th className="px-3 py-2.5 text-right">Target</th>
                <th className="px-3 py-2.5 text-right">Prior</th>
                <th className="px-3 py-2.5">Source refreshed</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const metric = widget.metrics.find((item) => item.id === row.metricId);
                return (
                  <tr key={`${row.metricId}-${row.organisationId}-${row.periodEnd}`} className="border-b border-line/70 last:border-0">
                    <th className="px-3 py-2.5 font-medium text-ink">{metric?.label ?? row.metricName}</th>
                    <td className="px-3 py-2.5 text-muted">{row.organisationName}</td>
                    <td className="px-3 py-2.5 text-muted">{shortDate(row.periodEnd)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">{formatValue(metric, row.actualValue)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{row.targetValue === null ? "—" : formatValue(metric, row.targetValue)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{row.priorPeriodValue === null ? "—" : formatValue(metric, row.priorPeriodValue)}</td>
                    <td className="px-3 py-2.5 text-muted">{DATE_TIME_FORMATTER.format(new Date(row.sourceRefreshedAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-line bg-canvas p-4 text-sm text-muted">
          No permitted aggregate rows are available for the active filters.
        </p>
      )}
    </details>
  );
}

function KpiVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const current = latestBy(rows, (row) => row.metricId, (row) => row.periodEnd);
  if (current.length === 0) return <EmptyVisual />;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {current.map((row) => {
        const metric = widget.metrics.find((item) => item.id === row.metricId);
        const state = metric ? thresholdState({
          actualValue: row.actualValue,
          targetValue: row.targetValue,
          favourableDirection: metric.favourableDirection,
          thresholds: metric.thresholds,
        }) : "no_threshold";
        const stateClass = state === "green" ? "bg-emerald-50 text-emerald-900" : state === "amber" ? "bg-amber-50 text-amber-900" : state === "red" ? "bg-red-50 text-red-900" : "bg-canvas text-muted";
        return (
          <div key={`${row.metricId}-${row.organisationId}`} className="rounded-lg border border-line bg-canvas p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs font-semibold text-muted">{metric?.label ?? row.metricName}</p>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${stateClass}`}>{state.replace("no_threshold", "No band")}</span>
            </div>
            <p className="mt-3 font-display text-3xl font-bold tracking-tight text-ink">{formatValue(metric, row.actualValue)}</p>
            <p className="mt-2 text-xs text-muted">
              {row.targetValue === null ? "No target" : `Target ${formatValue(metric, row.targetValue)}`} · {shortDate(row.periodEnd)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

interface PlotPoint { x: number; y: number; label: string; value: number }

function seriesFor(widget: AnalyticsWidgetDefinition, rows: AnalyticsValuePoint[]) {
  const groups = new Map<string, { label: string; metric: AnalyticsMetricReference | undefined; rows: AnalyticsValuePoint[] }>();
  for (const row of rows) {
    const key = widget.sourceMode === "children" ? row.organisationId : row.metricId;
    const metric = widget.metrics.find((item) => item.id === row.metricId);
    const group = groups.get(key) ?? {
      label: widget.sourceMode === "children" ? row.organisationName : metric?.label ?? row.metricName,
      metric,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    rows: [...group.rows].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)),
  }));
}

function TrendVisual({ widget, rows, area }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[]; area: boolean }) {
  const series = seriesFor(widget, rows).filter((item) => item.rows.length >= 2);
  if (series.length === 0) return <EmptyVisual message="At least two permitted periods are needed for this trend." />;
  const allValues = series.flatMap((item) => item.rows.map((row) => row.actualValue));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;
  const width = 640;
  const height = 250;
  const padX = 42;
  const padY = 26;
  const longest = Math.max(...series.map((item) => item.rows.length));
  const project = (item: typeof series[number]): PlotPoint[] => item.rows.map((row, index) => ({
    x: padX + (index / Math.max(longest - 1, 1)) * (width - padX * 2),
    y: height - padY - ((row.actualValue - min) / range) * (height - padY * 2),
    label: row.periodEnd,
    value: row.actualValue,
  }));
  return (
    <div>
      <svg role="img" aria-label={`${widget.title} ${area ? "area" : "line"} chart`} viewBox={`0 0 ${width} ${height}`} className="h-64 w-full" preserveAspectRatio="none">
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="#D6DEE2" />
        <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="#D6DEE2" />
        {series.map((item, index) => {
          const points = project(item);
          const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
          const fillPoints = `${padX},${height - padY} ${line} ${points.at(-1)?.x ?? width - padX},${height - padY}`;
          return (
            <g key={item.label}>
              {area && <polygon points={fillPoints} fill={PALETTE[index % PALETTE.length]} opacity={series.length === 1 ? 0.18 : 0.09} />}
              <polyline points={line} fill="none" stroke={PALETTE[index % PALETTE.length]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              {points.map((point) => <circle key={`${item.label}-${point.label}`} cx={point.x} cy={point.y} r="3.5" fill={PALETTE[index % PALETTE.length]} />)}
            </g>
          );
        })}
        <text x={padX} y={height - 6} fill="#5B6B76" fontSize="11">{shortDate(series[0].rows[0].periodEnd)}</text>
        <text x={width - padX} y={height - 6} fill="#5B6B76" fontSize="11" textAnchor="end">{shortDate(series[0].rows.at(-1)?.periodEnd ?? series[0].rows[0].periodEnd)}</text>
        <text x={padX - 6} y={padY + 4} fill="#5B6B76" fontSize="11" textAnchor="end">{max.toFixed(1)}</text>
        <text x={padX - 6} y={height - padY + 4} fill="#5B6B76" fontSize="11" textAnchor="end">{min.toFixed(1)}</text>
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
        {series.map((item, index) => <span key={item.label} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: PALETTE[index % PALETTE.length] }} />{item.label}</span>)}
      </div>
    </div>
  );
}

function categoricalRows(widget: AnalyticsWidgetDefinition, rows: AnalyticsValuePoint[]) {
  return latestBy(rows, (row) => `${row.metricId}:${row.organisationId}`, (row) => row.periodEnd).map((row) => ({
    row,
    metric: widget.metrics.find((item) => item.id === row.metricId),
    label: widget.sourceMode === "children" ? row.organisationName : widget.metrics.find((item) => item.id === row.metricId)?.label ?? row.metricName,
  }));
}

function BarVisual({ widget, rows, horizontal }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[]; horizontal: boolean }) {
  const items = categoricalRows(widget, rows).slice(0, 12);
  if (items.length === 0) return <EmptyVisual />;
  const max = Math.max(...items.map((item) => Math.abs(item.row.actualValue)), 1);
  const width = 640;
  const height = Math.max(220, horizontal ? items.length * 42 + 30 : 250);
  const pad = horizontal ? 130 : 42;
  return (
    <svg role="img" aria-label={`${widget.title} ${horizontal ? "horizontal" : "vertical"} bar chart`} viewBox={`0 0 ${width} ${height}`} className={horizontal ? "w-full" : "h-64 w-full"} style={horizontal ? { minHeight: `${height}px` } : undefined}>
      {items.map((item, index) => {
        const colour = PALETTE[index % PALETTE.length];
        if (horizontal) {
          const barWidth = (Math.abs(item.row.actualValue) / max) * (width - pad - 55);
          const y = 14 + index * 42;
          return <g key={`${item.row.metricId}-${item.row.organisationId}`}><text x={pad - 8} y={y + 16} textAnchor="end" fill="#5B6B76" fontSize="12">{item.label.slice(0, 20)}</text><rect x={pad} y={y} width={barWidth} height="22" rx="4" fill={colour} /><text x={Math.min(pad + barWidth + 7, width - 5)} y={y + 16} fill="#0F2A43" fontSize="12">{formatValue(item.metric, item.row.actualValue)}</text></g>;
        }
        const slot = (width - pad * 2) / items.length;
        const barHeight = (Math.abs(item.row.actualValue) / max) * (height - 80);
        const x = pad + index * slot + slot * 0.18;
        const y = height - 42 - barHeight;
        return <g key={`${item.row.metricId}-${item.row.organisationId}`}><rect x={x} y={y} width={slot * 0.64} height={barHeight} rx="4" fill={colour} /><text x={x + slot * 0.32} y={height - 24} textAnchor="middle" fill="#5B6B76" fontSize="10">{item.label.slice(0, 12)}</text><text x={x + slot * 0.32} y={Math.max(y - 6, 12)} textAnchor="middle" fill="#0F2A43" fontSize="10">{formatValue(item.metric, item.row.actualValue)}</text></g>;
      })}
    </svg>
  );
}

function StackedBarVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items = categoricalRows(widget, rows).slice(0, 10);
  if (items.length === 0) return <EmptyVisual />;
  return (
    <div className="space-y-4">
      {items.map((item) => {
        const target = item.row.targetValue;
        const attainment = target && target !== 0 ? Math.max(0, Math.min(100, (item.row.actualValue / target) * 100)) : 100;
        return (
          <div key={`${item.row.metricId}-${item.row.organisationId}`}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="font-medium text-ink">{item.label}</span><span className="text-muted">{target === null ? formatValue(item.metric, item.row.actualValue) : `${attainment.toFixed(0)}% of target`}</span></div>
            <div className="flex h-5 overflow-hidden rounded bg-line"><span className="bg-teal" style={{ width: `${attainment}%` }} /><span className="bg-amber-200" style={{ width: `${100 - attainment}%` }} /></div>
          </div>
        );
      })}
      <p className="text-xs text-muted">Teal shows target attainment; amber shows the remaining gap.</p>
    </div>
  );
}

function DonutVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items = categoricalRows(widget, rows).filter((item) => item.row.actualValue > 0).slice(0, 8);
  const total = items.reduce((sum, item) => sum + item.row.actualValue, 0);
  if (!total) return <EmptyVisual message="Positive permitted values are needed for a donut visual." />;
  const offsets = items.map((_, index) => items
    .slice(0, index)
    .reduce((sum, item) => sum + (item.row.actualValue / total) * 452.39, 0));
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[220px_1fr]">
      <svg role="img" aria-label={`${widget.title} donut chart`} viewBox="0 0 220 220" className="mx-auto h-52 w-52 -rotate-90">
        <circle cx="110" cy="110" r="72" fill="none" stroke="#E7ECEE" strokeWidth="36" />
        {items.map((item, index) => {
          const fraction = item.row.actualValue / total;
          const dash = fraction * 452.39;
          return <circle key={`${item.row.metricId}-${item.row.organisationId}`} cx="110" cy="110" r="72" fill="none" stroke={PALETTE[index % PALETTE.length]} strokeWidth="36" strokeDasharray={`${dash} ${452.39 - dash}`} strokeDashoffset={-offsets[index]} />;
        })}
      </svg>
      <div className="space-y-2 text-xs">
        {items.map((item, index) => <div key={`${item.row.metricId}-${item.row.organisationId}`} className="flex items-center justify-between gap-3"><span className="inline-flex min-w-0 items-center gap-2 text-muted"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PALETTE[index % PALETTE.length] }} /><span className="truncate">{item.label}</span></span><span className="font-semibold text-ink">{((item.row.actualValue / total) * 100).toFixed(0)}%</span></div>)}
      </div>
    </div>
  );
}

function GaugeVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const item = categoricalRows(widget, rows)[0];
  if (!item) return <EmptyVisual />;
  const target = item.row.targetValue;
  const percent = target && target !== 0 ? Math.max(0, Math.min(150, (item.row.actualValue / target) * 100)) : 0;
  const angle = -90 + (Math.min(percent, 100) / 100) * 180;
  const radians = (angle * Math.PI) / 180;
  const x = 160 + Math.cos(radians) * 90;
  const y = 132 + Math.sin(radians) * 90;
  return (
    <div className="text-center">
      <svg role="img" aria-label={`${item.label} target attainment ${percent.toFixed(0)} percent`} viewBox="0 0 320 180" className="mx-auto h-44 w-full max-w-sm">
        <path d="M55 132 A105 105 0 0 1 265 132" fill="none" stroke="#E7ECEE" strokeWidth="28" strokeLinecap="round" />
        <path d="M55 132 A105 105 0 0 1 265 132" fill="none" stroke="#17A2A6" strokeWidth="28" strokeLinecap="round" pathLength="100" strokeDasharray={`${Math.min(percent, 100)} 100`} />
        <line x1="160" y1="132" x2={x} y2={y} stroke="#0F2A43" strokeWidth="5" strokeLinecap="round" />
        <circle cx="160" cy="132" r="9" fill="#0F2A43" />
      </svg>
      <p className="-mt-4 font-display text-3xl font-bold text-ink">{formatValue(item.metric, item.row.actualValue)}</p>
      <p className="mt-1 text-xs text-muted">{target === null ? "Add a target to calculate attainment" : `${percent.toFixed(0)}% of ${formatValue(item.metric, target)} target`}</p>
    </div>
  );
}

function FunnelVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items = categoricalRows(widget, rows).slice(0, 8);
  const max = Math.max(...items.map((item) => item.row.actualValue), 0);
  if (!max || items.length < 2) return <EmptyVisual message="Choose at least two compatible positive KPIs for a funnel." />;
  return (
    <div className="space-y-2">
      {items.map((item, index) => {
        const width = Math.max(24, (item.row.actualValue / max) * 100);
        return <div key={`${item.row.metricId}-${item.row.organisationId}`} className="text-center"><div className="mx-auto rounded-md px-3 py-2 text-xs font-semibold text-white" style={{ width: `${width}%`, backgroundColor: PALETTE[index % PALETTE.length] }}>{item.label} · {formatValue(item.metric, item.row.actualValue)}</div></div>;
      })}
    </div>
  );
}

function HeatmapVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const metric = widget.metrics[0];
  const filtered = metric ? rows.filter((row) => row.metricId === metric.id) : [];
  const organisations = [...new Set(filtered.map((row) => row.organisationName))].slice(0, 8);
  const periods = [...new Set(filtered.map((row) => row.periodEnd))].sort().slice(-8);
  if (organisations.length === 0 || periods.length < 2) return <EmptyVisual message="Heatmaps need child-area values across at least two periods." />;
  const values = filtered.map((row) => row.actualValue);
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const lookup = new Map(filtered.map((row) => [`${row.organisationName}:${row.periodEnd}`, row]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-xs">
        <thead><tr><th className="p-2 text-left font-medium text-muted">Area</th>{periods.map((period) => <th key={period} className="p-2 text-center font-medium text-muted">{shortDate(period)}</th>)}</tr></thead>
        <tbody>{organisations.map((organisation) => <tr key={organisation}><th className="p-2 text-left font-medium text-ink">{organisation}</th>{periods.map((period) => { const row = lookup.get(`${organisation}:${period}`); const intensity = row ? 0.15 + ((row.actualValue - min) / range) * 0.75 : 0; return <td key={period} className="rounded p-2 text-center font-semibold" style={row ? { backgroundColor: `rgb(23 162 166 / ${intensity})`, color: intensity > 0.55 ? "white" : "#0F2A43" } : { backgroundColor: "#F2F5F6", color: "#5B6B76" }}>{row ? formatValue(metric, row.actualValue) : "—"}</td>; })}</tr>)}</tbody>
      </table>
    </div>
  );
}

function TableVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items = categoricalRows(widget, rows);
  if (items.length === 0) return <EmptyVisual />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead><tr className="border-b border-line text-xs uppercase tracking-wide text-muted"><th className="px-2 py-3">Measure</th><th className="px-2 py-3 text-right">Actual</th><th className="px-2 py-3 text-right">Target</th><th className="px-2 py-3 text-right">Variance</th><th className="px-2 py-3">Period</th></tr></thead>
        <tbody>{items.map((item) => <tr key={`${item.row.metricId}-${item.row.organisationId}`} className="border-b border-line/70 last:border-0"><th className="px-2 py-3 font-medium text-ink">{item.label}</th><td className="px-2 py-3 text-right font-semibold text-ink">{formatValue(item.metric, item.row.actualValue)}</td><td className="px-2 py-3 text-right text-muted">{item.row.targetValue === null ? "—" : formatValue(item.metric, item.row.targetValue)}</td><td className="px-2 py-3 text-right text-muted">{item.row.targetValue === null ? "—" : formatValue(item.metric, item.row.actualValue - item.row.targetValue)}</td><td className="px-2 py-3 text-muted">{shortDate(item.row.periodEnd)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ComboVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const series = seriesFor(widget, rows).filter((item) => item.rows.length >= 2).slice(0, 2);
  if (series.length !== 2) return <EmptyVisual message="Line + column charts need two compatible KPI series across at least two periods." />;
  const periods = [...new Set(series.flatMap((item) => item.rows.map((row) => row.periodEnd)))].sort().slice(-12);
  const lookup = series.map((item) => new Map(item.rows.map((row) => [row.periodEnd, row.actualValue])));
  const values = series.flatMap((item) => item.rows.map((row) => row.actualValue));
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const width = 640; const height = 250; const padX = 45; const padY = 25;
  const slot = (width - padX * 2) / periods.length;
  const y = (value: number) => height - padY - ((value - min) / range) * (height - padY * 2);
  const points = periods.map((period, index) => ({ x: padX + slot * index + slot / 2, y: lookup[1].has(period) ? y(lookup[1].get(period) ?? 0) : null }));
  return <div><svg role="img" aria-label={`${widget.title} line and column chart`} viewBox={`0 0 ${width} ${height}`} className="h-64 w-full" preserveAspectRatio="none">
    <line x1={padX} y1={y(0)} x2={width-padX} y2={y(0)} stroke="#D6DEE2" />
    {periods.map((period, index) => { const value = lookup[0].get(period); if (value === undefined) return null; const barY = y(Math.max(value, 0)); return <rect key={period} x={padX + index * slot + slot * .18} y={barY} width={slot * .64} height={Math.max(2, Math.abs(y(value)-y(0)))} rx="3" fill={PALETTE[0]} opacity=".8"/>; })}
    <polyline points={points.filter((point) => point.y !== null).map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={PALETTE[2]} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    {points.map((point, index) => point.y === null ? null : <circle key={periods[index]} cx={point.x} cy={point.y} r="4" fill={PALETTE[2]}/>)}
  </svg><div className="flex gap-4 text-xs text-muted"><span>■ {series[0].label}</span><span className="text-warning">● {series[1].label}</span></div></div>;
}

function WaterfallVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items = categoricalRows(widget, rows).slice(0, 10);
  if (items.length < 2) return <EmptyVisual message="Waterfalls need at least two permitted contributions." />;
  const totals: number[] = []; let cumulative = 0;
  for (const item of items) { cumulative += item.row.actualValue; totals.push(cumulative); }
  const low = Math.min(0, ...totals); const high = Math.max(0, ...totals); const range = high-low || 1;
  const width=640; const height=250; const pad=42; const slot=(width-pad*2)/items.length;
  const y=(value:number)=>height-30-((value-low)/range)*(height-60);
  return <svg role="img" aria-label={`${widget.title} waterfall chart`} viewBox={`0 0 ${width} ${height}`} className="h-64 w-full">
    <line x1={pad} y1={y(0)} x2={width-pad} y2={y(0)} stroke="#AEBBC1"/>
    {items.map((item,index)=>{const start=index ? totals[index-1] : 0; const end=totals[index]; const top=y(Math.max(start,end)); const bottom=y(Math.min(start,end)); const x=pad+index*slot+slot*.15; return <g key={`${item.row.metricId}-${item.row.organisationId}`}><rect x={x} y={top} width={slot*.7} height={Math.max(2,bottom-top)} rx="3" fill={item.row.actualValue>=0?"#17A2A6":"#D64545"}/>{index>0&&<line x1={x-slot*.15} y1={y(start)} x2={x} y2={y(start)} stroke="#AEBBC1" strokeDasharray="3 3"/>}<text x={x+slot*.35} y={height-10} textAnchor="middle" fill="#5B6B76" fontSize="9">{item.label.slice(0,10)}</text></g>})}
  </svg>;
}

function TreemapVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items = categoricalRows(widget, rows).filter((item)=>item.row.actualValue>0).sort((a,b)=>b.row.actualValue-a.row.actualValue).slice(0,12);
  const total=items.reduce((sum,item)=>sum+item.row.actualValue,0);
  if (!total) return <EmptyVisual message="Treemaps need positive permitted values."/>;
  return <div className="flex min-h-56 flex-wrap content-stretch gap-1 rounded-lg bg-canvas p-1">{items.map((item,index)=><div key={`${item.row.metricId}-${item.row.organisationId}`} className="flex min-h-20 flex-col justify-end rounded-md p-3 text-white" style={{backgroundColor:PALETTE[index%PALETTE.length],flexGrow:Math.max(1,item.row.actualValue/total*100),flexBasis:`${Math.max(20,item.row.actualValue/total*100)}%`}}><span className="text-xs font-semibold">{item.label}</span><span className="mt-1 text-lg font-bold">{formatValue(item.metric,item.row.actualValue)}</span></div>)}</div>;
}

function RadarVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const items=categoricalRows(widget,rows).slice(0,8);
  if(items.length<3)return <EmptyVisual message="Radar charts need at least three permitted measures."/>;
  const max=Math.max(...items.map((item)=>Math.abs(item.row.actualValue)),1); const cx=160; const cy=145; const radius=105;
  const point=(index:number,factor:number)=>{const angle=-Math.PI/2+(index/items.length)*Math.PI*2; return `${cx+Math.cos(angle)*radius*factor},${cy+Math.sin(angle)*radius*factor}`};
  return <svg role="img" aria-label={`${widget.title} radar chart`} viewBox="0 0 320 300" className="mx-auto h-72 w-full max-w-lg">{[.25,.5,.75,1].map(level=><polygon key={level} points={items.map((_,i)=>point(i,level)).join(" ")} fill="none" stroke="#D6DEE2"/>)}{items.map((item,i)=><g key={item.label}><line x1={cx} y1={cy} x2={point(i,1).split(",")[0]} y2={point(i,1).split(",")[1]} stroke="#D6DEE2"/><text x={point(i,1.15).split(",")[0]} y={point(i,1.15).split(",")[1]} textAnchor="middle" fontSize="10" fill="#5B6B76">{item.label.slice(0,16)}</text></g>)}<polygon points={items.map((item,i)=>point(i,Math.abs(item.row.actualValue)/max)).join(" ")} fill="#17A2A6" fillOpacity=".22" stroke="#0E7C80" strokeWidth="3"/></svg>;
}

function ScatterVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const [xMetric,yMetric]=widget.metrics; if(!xMetric||!yMetric)return <EmptyVisual message="Scatter plots need exactly two governed KPIs."/>;
  const latest=categoricalRows(widget,rows); const byOrg=new Map<string,{name:string;x?:number;y?:number}>();
  for(const item of latest){const entry=byOrg.get(item.row.organisationId)??{name:item.row.organisationName}; if(item.row.metricId===xMetric.id)entry.x=item.row.actualValue; if(item.row.metricId===yMetric.id)entry.y=item.row.actualValue; byOrg.set(item.row.organisationId,entry)}
  const points=[...byOrg.values()].filter((item):item is {name:string;x:number;y:number}=>item.x!==undefined&&item.y!==undefined);
  if(points.length<2)return <EmptyVisual message="Scatter plots need both KPI values for at least two visible areas."/>;
  const xmin=Math.min(...points.map(p=>p.x)); const xmax=Math.max(...points.map(p=>p.x)); const ymin=Math.min(...points.map(p=>p.y)); const ymax=Math.max(...points.map(p=>p.y)); const width=640; const height=260; const pad=48;
  return <div><svg role="img" aria-label={`${widget.title} scatter plot`} viewBox={`0 0 ${width} ${height}`} className="h-64 w-full"><line x1={pad} y1={height-pad} x2={width-pad} y2={height-pad} stroke="#AEBBC1"/><line x1={pad} y1={pad} x2={pad} y2={height-pad} stroke="#AEBBC1"/>{points.map((p,i)=>{const x=pad+((p.x-xmin)/(xmax-xmin||1))*(width-pad*2);const y=height-pad-((p.y-ymin)/(ymax-ymin||1))*(height-pad*2);return <g key={p.name}><circle cx={x} cy={y} r="7" fill={PALETTE[i%PALETTE.length]} opacity=".85"/><text x={x+9} y={y-6} fontSize="10" fill="#5B6B76">{p.name.slice(0,16)}</text></g>})}</svg><div className="flex justify-between text-xs text-muted"><span>Horizontal: {xMetric.label}</span><span>Vertical: {yMetric.label}</span></div></div>;
}

function BulletVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  const item=categoricalRows(widget,rows)[0]; if(!item)return <EmptyVisual/>; const target=item.row.targetValue; const extent=Math.max(Math.abs(item.row.actualValue),Math.abs(target??0),1)*1.2; const actual=Math.max(0,item.row.actualValue/extent*100); const marker=target===null?null:Math.max(0,target/extent*100);
  return <div className="py-6"><div className="relative h-12 rounded bg-line"><div className="absolute inset-y-3 left-0 rounded-r bg-teal" style={{width:`${Math.min(actual,100)}%`}}/>{marker!==null&&<span className="absolute inset-y-0 w-1 bg-ink" style={{left:`${Math.min(marker,100)}%`}}/>}</div><div className="mt-3 flex justify-between text-sm"><span className="font-semibold text-ink">Actual {formatValue(item.metric,item.row.actualValue)}</span><span className="text-muted">{target===null?"No target set":`Target ${formatValue(item.metric,target)}`}</span></div></div>;
}

function AnalyticsVisual({ widget, rows }: { widget: AnalyticsWidgetDefinition; rows: AnalyticsValuePoint[] }) {
  if (widget.visualType === "text") return <div className="prose max-w-none whitespace-pre-wrap text-sm leading-7 text-muted">{widget.staticText}</div>;
  if (widget.visualType === "kpi") return <KpiVisual widget={widget} rows={rows} />;
  if (widget.visualType === "line") return <TrendVisual widget={widget} rows={rows} area={false} />;
  if (widget.visualType === "area") return <TrendVisual widget={widget} rows={rows} area />;
  if (widget.visualType === "bar") return <BarVisual widget={widget} rows={rows} horizontal={false} />;
  if (widget.visualType === "horizontal_bar") return <BarVisual widget={widget} rows={rows} horizontal />;
  if (widget.visualType === "stacked_bar") return <StackedBarVisual widget={widget} rows={rows} />;
  if (widget.visualType === "donut") return <DonutVisual widget={widget} rows={rows} />;
  if (widget.visualType === "gauge") return <GaugeVisual widget={widget} rows={rows} />;
  if (widget.visualType === "funnel") return <FunnelVisual widget={widget} rows={rows} />;
  if (widget.visualType === "heatmap") return <HeatmapVisual widget={widget} rows={rows} />;
  if (widget.visualType === "combo") return <ComboVisual widget={widget} rows={rows} />;
  if (widget.visualType === "waterfall") return <WaterfallVisual widget={widget} rows={rows} />;
  if (widget.visualType === "treemap") return <TreemapVisual widget={widget} rows={rows} />;
  if (widget.visualType === "radar") return <RadarVisual widget={widget} rows={rows} />;
  if (widget.visualType === "scatter") return <ScatterVisual widget={widget} rows={rows} />;
  if (widget.visualType === "bullet") return <BulletVisual widget={widget} rows={rows} />;
  return <TableVisual widget={widget} rows={rows} />;
}

export function AnalyticsViewRenderer({ runtime }: { runtime: AnalyticsViewRuntime }) {
  if (runtime.view.widgets.length === 0) return <EmptyVisual message="This view has no visuals yet." />;
  return (
    <section aria-label={`${runtime.view.name} visuals`} className="grid grid-cols-1 gap-4 md:grid-cols-12">
      {runtime.view.widgets.map((widget) => {
        const rows = widgetValues(runtime, widget);
        return (
          <article key={widget.id} className={`${WIDTH_CLASSES[widget.width] ?? "md:col-span-6"} rounded-xl border border-line bg-panel p-4 shadow-sm sm:p-5`}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-ink">{widget.title}</h2>
                {widget.subtitle && <p className="mt-1 text-xs leading-5 text-muted">{widget.subtitle}</p>}
              </div>
              <span className="shrink-0 rounded-full bg-canvas px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{widget.visualType.replaceAll("_", " ")}</span>
            </div>
            <AnalyticsVisual widget={widget} rows={rows} />
            {widget.visualType !== "text" && <InspectDataTable widget={widget} rows={rows} />}
          </article>
        );
      })}
    </section>
  );
}
