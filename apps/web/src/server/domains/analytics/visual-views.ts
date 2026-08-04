import type { PoolClient } from "@neondatabase/serverless";
import { getPulseHierarchy, type KpiDirection, type KpiUnit, type PulseHierarchy } from "../pulse/kpis";

export const ANALYTICS_SURFACES = ["pulse", "canvas"] as const;
export const ANALYTICS_VISUAL_TYPES = [
  "kpi",
  "line",
  "area",
  "bar",
  "horizontal_bar",
  "stacked_bar",
  "donut",
  "gauge",
  "funnel",
  "heatmap",
  "table",
  "text",
  "combo",
  "waterfall",
  "treemap",
  "radar",
  "scatter",
  "bullet",
] as const;
export const ANALYTICS_SOURCE_MODES = ["current", "children", "trend"] as const;
export const ANALYTICS_HEIGHTS = ["compact", "standard", "tall"] as const;

export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];
export type AnalyticsVisualType = (typeof ANALYTICS_VISUAL_TYPES)[number];
export type AnalyticsSourceMode = (typeof ANALYTICS_SOURCE_MODES)[number];
export type AnalyticsWidgetHeight = (typeof ANALYTICS_HEIGHTS)[number];
export type AnalyticsVisibility = "private" | "restricted" | "tenant";
export type AnalyticsViewStatus = "draft" | "published" | "archived";

export interface AnalyticsMetricReference {
  id: string;
  key: string;
  name: string;
  unit: KpiUnit;
  currencyCode: string | null;
  decimalPlaces: number;
  favourableDirection: KpiDirection;
  thresholds: Record<string, unknown>;
  label: string;
}

export interface AnalyticsWidgetDefinition {
  id: string;
  title: string;
  subtitle: string;
  visualType: AnalyticsVisualType;
  sourceMode: AnalyticsSourceMode;
  position: number;
  width: number;
  height: AnalyticsWidgetHeight;
  configuration: Record<string, unknown>;
  staticText: string;
  metrics: AnalyticsMetricReference[];
}

export interface AnalyticsViewSummary {
  id: string;
  surface: AnalyticsSurface;
  name: string;
  description: string;
  visibility: AnalyticsVisibility;
  status: AnalyticsViewStatus;
  isDefault: boolean;
  isOwner: boolean;
  canEdit: boolean;
  widgetCount: number;
  updatedAt: string;
}

export interface AnalyticsViewDetail extends AnalyticsViewSummary {
  ownerUserId: string;
  widgets: AnalyticsWidgetDefinition[];
}

export interface AnalyticsValuePoint {
  metricId: string;
  metricName: string;
  organisationId: string;
  organisationName: string;
  periodStart: string;
  periodEnd: string;
  actualValue: number;
  targetValue: number | null;
  priorPeriodValue: number | null;
  sourceRefreshedAt: string;
  expectedLatencySeconds: number;
}

export interface AnalyticsViewRuntime {
  view: AnalyticsViewDetail;
  hierarchy: PulseHierarchy | null;
  values: AnalyticsValuePoint[];
}

export interface AnalyticsMetricOption extends AnalyticsMetricReference {
  definition: string;
}

export async function listAnalyticsMetricOptions(
  client: PoolClient,
  input: { tenantId: string },
): Promise<AnalyticsMetricOption[]> {
  const { rows } = await client.query(
    `select id, kpi_key, name, definition, unit, currency_code,
            decimal_places, favourable_direction, thresholds
       from public.kpi_definitions
      where tenant_id = $1 and approval_status = 'approved'
        and valid_from <= current_date
        and (valid_to is null or valid_to > current_date)
      order by name, version_number desc`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    key: row.kpi_key,
    name: row.name,
    definition: row.definition,
    unit: row.unit as KpiUnit,
    currencyCode: row.currency_code,
    decimalPlaces: Number(row.decimal_places),
    favourableDirection: row.favourable_direction as KpiDirection,
    thresholds: row.thresholds ?? {},
    label: row.name,
  }));
}

interface ViewRow {
  id: string;
  surface: AnalyticsSurface;
  name: string;
  description: string;
  owner_user_id: string;
  visibility: AnalyticsVisibility;
  status: AnalyticsViewStatus;
  is_default: boolean;
  is_owner: boolean;
  can_edit: boolean;
  widget_count: number | string;
  updated_at: string | Date | number;
}

function mapSummary(row: ViewRow): AnalyticsViewSummary {
  return {
    id: row.id,
    surface: row.surface,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    isDefault: row.is_default,
    isOwner: row.is_owner,
    canEdit: row.can_edit,
    widgetCount: Number(row.widget_count),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listAnalyticsViews(
  client: PoolClient,
  input: { tenantId: string; surface: AnalyticsSurface },
): Promise<AnalyticsViewSummary[]> {
  const { rows } = await client.query<ViewRow>(
    `select view_row.id, view_row.surface, view_row.name, view_row.description,
            view_row.owner_user_id, view_row.visibility, view_row.status,
            view_row.is_default,
            view_row.owner_user_id = public.current_user_id() as is_owner,
            public.can_edit_analytics_view(view_row.tenant_id, view_row.id) as can_edit,
            count(widget.id)::integer as widget_count,
            extract(epoch from view_row.updated_at) as updated_at
       from public.analytics_views view_row
       left join public.analytics_widgets widget
         on widget.tenant_id = view_row.tenant_id and widget.view_id = view_row.id
      where view_row.tenant_id = $1 and view_row.surface = $2
      group by view_row.id
      order by view_row.is_default desc, view_row.updated_at desc, view_row.name`,
    [input.tenantId, input.surface],
  );
  return rows.map((row) => mapSummary({ ...row, updated_at: Number(row.updated_at) * 1_000 }));
}

interface DetailRow extends ViewRow {
  widgets: unknown[];
}

function parseMetric(value: unknown): AnalyticsMetricReference {
  const metric = value as Record<string, unknown>;
  return {
    id: String(metric.id),
    key: String(metric.key),
    name: String(metric.name),
    unit: metric.unit as KpiUnit,
    currencyCode: metric.currencyCode === null ? null : String(metric.currencyCode),
    decimalPlaces: Number(metric.decimalPlaces),
    favourableDirection: metric.favourableDirection as KpiDirection,
    thresholds: (metric.thresholds ?? {}) as Record<string, unknown>,
    label: String(metric.label || metric.name),
  };
}

function parseWidget(value: unknown): AnalyticsWidgetDefinition {
  const widget = value as Record<string, unknown>;
  return {
    id: String(widget.id),
    title: String(widget.title),
    subtitle: String(widget.subtitle ?? ""),
    visualType: widget.visualType as AnalyticsVisualType,
    sourceMode: widget.sourceMode as AnalyticsSourceMode,
    position: Number(widget.position),
    width: Number(widget.width),
    height: widget.height as AnalyticsWidgetHeight,
    configuration: (widget.configuration ?? {}) as Record<string, unknown>,
    staticText: String(widget.staticText ?? ""),
    metrics: ((widget.metrics ?? []) as unknown[]).map(parseMetric),
  };
}

export async function getAnalyticsView(
  client: PoolClient,
  input: { tenantId: string; viewId: string },
): Promise<AnalyticsViewDetail | null> {
  const { rows: [row] } = await client.query<DetailRow>(
    `with metric_groups as (
       select metric.tenant_id, metric.widget_id,
              jsonb_agg(
                jsonb_build_object(
                  'id', definition.id,
                  'key', definition.kpi_key,
                  'name', definition.name,
                  'unit', definition.unit,
                  'currencyCode', definition.currency_code,
                  'decimalPlaces', definition.decimal_places,
                  'favourableDirection', definition.favourable_direction,
                  'thresholds', definition.thresholds,
                  'label', coalesce(nullif(metric.series_label, ''), definition.name)
                ) order by metric.position, definition.name
              ) as metrics
         from public.analytics_widget_metrics metric
         join public.kpi_definitions definition
           on definition.id = metric.kpi_definition_id
          and definition.tenant_id = metric.tenant_id
        where metric.tenant_id = $1
        group by metric.tenant_id, metric.widget_id
     ), widget_groups as (
       select widget.tenant_id, widget.view_id,
              jsonb_agg(
                jsonb_build_object(
                  'id', widget.id,
                  'title', widget.title,
                  'subtitle', widget.subtitle,
                  'visualType', widget.visual_type,
                  'sourceMode', widget.source_mode,
                  'position', widget.position,
                  'width', widget.width,
                  'height', widget.height,
                  'configuration', widget.configuration,
                  'staticText', widget.static_text,
                  'metrics', coalesce(metric_groups.metrics, '[]'::jsonb)
                ) order by widget.position, widget.id
              ) as widgets
         from public.analytics_widgets widget
         left join metric_groups
           on metric_groups.tenant_id = widget.tenant_id and metric_groups.widget_id = widget.id
        where widget.tenant_id = $1
        group by widget.tenant_id, widget.view_id
     )
     select view_row.id, view_row.surface, view_row.name, view_row.description,
            view_row.owner_user_id, view_row.visibility, view_row.status,
            view_row.is_default,
            view_row.owner_user_id = public.current_user_id() as is_owner,
            public.can_edit_analytics_view(view_row.tenant_id, view_row.id) as can_edit,
            coalesce(jsonb_array_length(widget_groups.widgets), 0)::integer as widget_count,
            extract(epoch from view_row.updated_at) as updated_at,
            coalesce(widget_groups.widgets, '[]'::jsonb) as widgets
       from public.analytics_views view_row
       left join widget_groups
         on widget_groups.tenant_id = view_row.tenant_id and widget_groups.view_id = view_row.id
      where view_row.tenant_id = $1 and view_row.id = $2
      limit 1`,
    [input.tenantId, input.viewId],
  );
  if (!row) return null;
  return {
    ...mapSummary({ ...row, updated_at: Number(row.updated_at) * 1_000 }),
    ownerUserId: row.owner_user_id,
    widgets: (row.widgets ?? []).map(parseWidget),
  };
}

export async function getDefaultPulseView(
  client: PoolClient,
  input: { tenantId: string },
): Promise<AnalyticsViewDetail | null> {
  const { rows: [row] } = await client.query<{ id: string }>(
    `select id
       from public.analytics_views
      where tenant_id = $1 and surface = 'pulse'
        and status = 'published' and is_default
      limit 1`,
    [input.tenantId],
  );
  return row ? getAnalyticsView(client, { tenantId: input.tenantId, viewId: row.id }) : null;
}

export async function createAnalyticsView(
  client: PoolClient,
  input: {
    tenantId: string;
    surface: AnalyticsSurface;
    name: string;
    description: string;
    actorUserId: string;
  },
): Promise<{ id: string }> {
  const { rows: [created] } = await client.query<{ id: string }>(
    `insert into public.analytics_views
       (tenant_id, surface, name, description, owner_user_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5, $5)
     returning id`,
    [input.tenantId, input.surface, input.name, input.description, input.actorUserId],
  );
  if (!created) throw new Error("The view could not be created.");
  return created;
}

export async function updateAnalyticsView(
  client: PoolClient,
  input: {
    tenantId: string;
    viewId: string;
    name: string;
    description: string;
    visibility: AnalyticsVisibility;
    actorUserId: string;
  },
): Promise<void> {
  const result = await client.query(
    `update public.analytics_views
        set name = $3, description = $4, visibility = $5,
            updated_by = $6, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [input.tenantId, input.viewId, input.name, input.description, input.visibility, input.actorUserId],
  );
  if (result.rowCount !== 1) throw new Error("The view is unavailable or you cannot edit it.");
}

export async function publishAnalyticsView(
  client: PoolClient,
  input: { tenantId: string; viewId: string; actorUserId: string; makeDefault: boolean },
): Promise<void> {
  const { rows: [view] } = await client.query<{ surface: AnalyticsSurface }>(
    `select surface from public.analytics_views where tenant_id = $1 and id = $2 for update`,
    [input.tenantId, input.viewId],
  );
  if (!view) throw new Error("The view is unavailable or you cannot publish it.");

  const { rows: [validation] } = await client.query<{ widget_count: number; invalid_widget_count: number }>(
    `select count(*)::integer as widget_count,
            count(*) filter (
              where widget.visual_type <> 'text'
                and not exists (
                  select 1
                  from public.analytics_widget_metrics metric
                  join public.kpi_definitions definition
                    on definition.id = metric.kpi_definition_id
                   and definition.tenant_id = metric.tenant_id
                  where metric.tenant_id = widget.tenant_id
                    and metric.widget_id = widget.id
                    and definition.approval_status = 'approved'
                )
            )::integer as invalid_widget_count
       from public.analytics_widgets widget
      where widget.tenant_id = $1 and widget.view_id = $2`,
    [input.tenantId, input.viewId],
  );
  if (!validation?.widget_count) throw new Error("Add at least one visual before publishing.");
  if (validation.invalid_widget_count > 0) throw new Error("Every non-text visual needs at least one approved KPI.");

  if (view.surface === "pulse" && input.makeDefault) {
    await client.query(
      `update public.analytics_views
          set is_default = false, updated_by = $3, updated_at = now()
        where tenant_id = $1 and surface = 'pulse' and is_default and id <> $2`,
      [input.tenantId, input.viewId, input.actorUserId],
    );
  }
  const result = await client.query(
    `update public.analytics_views
        set status = 'published',
            visibility = case when surface = 'pulse' then 'tenant' else visibility end,
            is_default = case when surface = 'pulse' then $3 else false end,
            updated_by = $4, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [input.tenantId, input.viewId, input.makeDefault, input.actorUserId],
  );
  if (result.rowCount !== 1) throw new Error("The view is unavailable or you cannot publish it.");
}

export async function addAnalyticsWidget(
  client: PoolClient,
  input: {
    tenantId: string;
    viewId: string;
    title: string;
    subtitle: string;
    visualType: AnalyticsVisualType;
    sourceMode: AnalyticsSourceMode;
    width: number;
    height: AnalyticsWidgetHeight;
    staticText: string;
    metricIds: string[];
    actorUserId: string;
  },
): Promise<{ id: string }> {
  if (input.visualType !== "text") {
    const { rows: definitions } = await client.query<{ id: string; unit: KpiUnit }>(
      `select id, unit from public.kpi_definitions
        where tenant_id = $1 and id = any($2::uuid[])
          and approval_status = 'approved'`,
      [input.tenantId, input.metricIds],
    );
    if (definitions.length !== input.metricIds.length) throw new Error("Every selected measure must be an approved KPI you can use.");
    const comparableVisuals: AnalyticsVisualType[] = ["donut", "funnel", "waterfall", "treemap", "radar", "combo"];
    if (comparableVisuals.includes(input.visualType) && new Set(definitions.map((definition) => definition.unit)).size > 1) {
      throw new Error("This visual requires KPIs with compatible units.");
    }
  }
  const { rows: [created] } = await client.query<{ id: string }>(
    `insert into public.analytics_widgets
       (tenant_id, view_id, title, subtitle, visual_type, source_mode,
        position, width, height, static_text, created_by, updated_by)
     select $1, $2, $3, $4, $5, $6,
            coalesce(max(position) + 1, 0), $7, $8, $9, $10, $10
       from public.analytics_widgets
      where tenant_id = $1 and view_id = $2
     returning id`,
    [
      input.tenantId,
      input.viewId,
      input.title,
      input.subtitle,
      input.visualType,
      input.sourceMode,
      input.width,
      input.height,
      input.staticText,
      input.actorUserId,
    ],
  );
  if (!created) throw new Error("The visual could not be created.");

  if (input.visualType !== "text" && input.metricIds.length > 0) {
    await client.query(
      `insert into public.analytics_widget_metrics
         (tenant_id, widget_id, kpi_definition_id, position)
       select $1, $2, metric_id, ordinal - 1
       from unnest($3::uuid[]) with ordinality as selected(metric_id, ordinal)`,
      [input.tenantId, created.id, input.metricIds],
    );
  }
  return created;
}

export async function removeAnalyticsWidget(
  client: PoolClient,
  input: { tenantId: string; viewId: string; widgetId: string; actorUserId: string },
): Promise<void> {
  const result = await client.query(
    `delete from public.analytics_widgets
      where tenant_id = $1 and view_id = $2 and id = $3`,
    [input.tenantId, input.viewId, input.widgetId],
  );
  if (result.rowCount !== 1) throw new Error("The visual is unavailable or you cannot remove it.");
  await client.query(
    `update public.analytics_widgets
        set position = position + 1000000000, updated_by = $3, updated_at = now()
      where tenant_id = $1 and view_id = $2`,
    [input.tenantId, input.viewId, input.actorUserId],
  );
  await client.query(
    `with ordered as (
       select id, row_number() over (order by position, id) - 1 as next_position
       from public.analytics_widgets where tenant_id = $1 and view_id = $2
     )
     update public.analytics_widgets widget
        set position = ordered.next_position, updated_by = $3, updated_at = now()
       from ordered where widget.id = ordered.id`,
    [input.tenantId, input.viewId, input.actorUserId],
  );
}

export async function moveAnalyticsWidget(
  client: PoolClient,
  input: { tenantId: string; viewId: string; widgetId: string; direction: "up" | "down"; actorUserId: string },
): Promise<void> {
  const { rows: [current] } = await client.query<{ position: number }>(
    `select position from public.analytics_widgets
      where tenant_id = $1 and view_id = $2 and id = $3 for update`,
    [input.tenantId, input.viewId, input.widgetId],
  );
  if (!current) throw new Error("The visual is unavailable or you cannot reorder it.");
  const targetPosition = current.position + (input.direction === "up" ? -1 : 1);
  if (targetPosition < 0) return;
  const { rows: [target] } = await client.query<{ id: string }>(
    `select id from public.analytics_widgets
      where tenant_id = $1 and view_id = $2 and position = $3 for update`,
    [input.tenantId, input.viewId, targetPosition],
  );
  if (!target) return;
  const temporaryPosition = 1_000_000_000 + current.position;
  await client.query(
    `update public.analytics_widgets
        set position = $4, updated_by = $5, updated_at = now()
      where tenant_id = $1 and view_id = $2 and id = $3`,
    [input.tenantId, input.viewId, input.widgetId, temporaryPosition, input.actorUserId],
  );
  await client.query(
    `update public.analytics_widgets
        set position = $4, updated_by = $5, updated_at = now()
      where tenant_id = $1 and view_id = $2 and id = $3`,
    [input.tenantId, input.viewId, target.id, current.position, input.actorUserId],
  );
  await client.query(
    `update public.analytics_widgets
        set position = $4, updated_by = $5, updated_at = now()
      where tenant_id = $1 and view_id = $2 and id = $3`,
    [input.tenantId, input.viewId, input.widgetId, targetPosition, input.actorUserId],
  );
}

export async function resizeAnalyticsWidget(
  client: PoolClient,
  input: { tenantId: string; viewId: string; widgetId: string; width: number; actorUserId: string },
): Promise<void> {
  const result = await client.query(
    `update public.analytics_widgets
        set width = $4, updated_by = $5, updated_at = now()
      where tenant_id = $1 and view_id = $2 and id = $3`,
    [input.tenantId, input.viewId, input.widgetId, input.width, input.actorUserId],
  );
  if (result.rowCount !== 1) throw new Error("The visual is unavailable or you cannot resize it.");
}

export async function loadAnalyticsViewRuntime(
  client: PoolClient,
  input: { tenantId: string; viewId: string; requestedOrgNodeId?: string | null },
): Promise<AnalyticsViewRuntime | null> {
  const view = await getAnalyticsView(client, { tenantId: input.tenantId, viewId: input.viewId });
  if (!view) return null;
  const hierarchy = await getPulseHierarchy(client, {
    tenantId: input.tenantId,
    requestedOrgNodeId: input.requestedOrgNodeId,
  });
  const metricIds = [...new Set(view.widgets.flatMap((widget) => widget.metrics.map((metric) => metric.id)))];
  const organisationIds = hierarchy
    ? [hierarchy.selected.id, ...hierarchy.children.map((child) => child.id)]
    : [];
  if (metricIds.length === 0 || organisationIds.length === 0) return { view, hierarchy, values: [] };

  const { rows } = await client.query(
    `with ranked as (
       select value.kpi_definition_id, definition.name as metric_name,
              value.org_node_id, version.name as organisation_name,
              value.period_start::text as period_start,
              value.period_end::text as period_end,
              value.actual_value, value.target_value, value.prior_period_value,
              extract(epoch from value.source_refreshed_at) as source_refreshed_epoch,
              extract(epoch from dataset.expected_latency)::integer as expected_latency_seconds,
              row_number() over (
                partition by value.kpi_definition_id, value.org_node_id
                order by value.period_end desc, value.calculated_at desc
              ) as recency_rank
         from public.kpi_values value
         join public.kpi_definitions definition
           on definition.id = value.kpi_definition_id and definition.tenant_id = value.tenant_id
         join public.governed_datasets dataset
           on dataset.id = definition.dataset_id and dataset.tenant_id = definition.tenant_id
         join public.org_node_versions version
           on version.org_node_id = value.org_node_id and version.tenant_id = value.tenant_id
          and version.valid_from <= current_date
          and (version.valid_to is null or version.valid_to > current_date)
        where value.tenant_id = $1
          and value.kpi_definition_id = any($2::uuid[])
          and value.org_node_id = any($3::uuid[])
          and definition.approval_status = 'approved'
     )
     select * from ranked where recency_rank <= 12
     order by metric_name, organisation_name, period_end`,
    [input.tenantId, metricIds, organisationIds],
  );
  return {
    view,
    hierarchy,
    values: rows.map((row) => ({
      metricId: row.kpi_definition_id,
      metricName: row.metric_name,
      organisationId: row.org_node_id,
      organisationName: row.organisation_name,
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      actualValue: Number(row.actual_value),
      targetValue: row.target_value === null ? null : Number(row.target_value),
      priorPeriodValue: row.prior_period_value === null ? null : Number(row.prior_period_value),
      sourceRefreshedAt: new Date(Number(row.source_refreshed_epoch) * 1_000).toISOString(),
      expectedLatencySeconds: Number(row.expected_latency_seconds),
    })),
  };
}
