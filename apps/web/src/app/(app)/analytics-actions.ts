"use server";

import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import {
  ANALYTICS_HEIGHTS,
  ANALYTICS_GRANT_PERMISSIONS,
  ANALYTICS_GRANT_TYPES,
  ANALYTICS_SOURCE_MODES,
  ANALYTICS_SURFACES,
  ANALYTICS_VISUAL_TYPES,
  addAnalyticsWidget,
  createAnalyticsView,
  duplicateAnalyticsView,
  moveAnalyticsWidget,
  publishAnalyticsView,
  removeAnalyticsViewGrant,
  removeAnalyticsWidget,
  resizeAnalyticsWidget,
  setAnalyticsViewGrant,
  updateAnalyticsView,
  type AnalyticsSurface,
  type AnalyticsVisibility,
} from "@/server/domains/analytics/visual-views";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WIDTHS = [3, 4, 6, 8, 12] as const;
const VISIBILITIES: AnalyticsVisibility[] = ["private", "restricted", "tenant"];

function textValue(formData: FormData, name: string, label: string, max: number, required = true): string {
  const value = String(formData.get(name) ?? "").trim();
  if ((required && !value) || value.length > max) {
    throw new Error(`${label}${required ? " is required and" : ""} must be ${max} characters or fewer.`);
  }
  return value;
}

function uuidValue(formData: FormData, name: string, label: string): string {
  const value = String(formData.get(name) ?? "");
  if (!UUID_PATTERN.test(value)) throw new Error(`Choose a valid ${label}.`);
  return value;
}

function enumValue<T extends string>(formData: FormData, name: string, allowed: readonly T[], label: string): T {
  const value = String(formData.get(name) ?? "") as T;
  if (!allowed.includes(value)) throw new Error(`Choose a valid ${label}.`);
  return value;
}

async function requireAnalyticsAccess(surface: AnalyticsSurface, editing: boolean) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (surface === "pulse" && editing && ctx.role !== "company_admin" && ctx.role !== "analyst") {
    throw new Error("Only a Company Admin or Analyst can configure Pulse.");
  }
  await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: surface }),
  );
  return ctx;
}

function revalidateView(surface: AnalyticsSurface, viewId?: string) {
  revalidatePath(surface === "pulse" ? "/dashboard" : "/canvas");
  revalidatePath(surface === "pulse" ? "/admin/dashboards" : "/canvas");
  if (viewId) revalidatePath(surface === "pulse" ? `/admin/dashboards/${viewId}` : `/canvas/${viewId}`);
}

export async function createAnalyticsViewAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const name = textValue(formData, "name", "Name", 120);
  const description = textValue(formData, "description", "Description", 500, false);
  const created = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const view = await createAnalyticsView(client, { tenantId: ctx.tenant.id, surface, name, description, actorUserId: ctx.profileId });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: `${surface}.view_created`,
      targetType: "analytics_view",
      targetId: view.id,
      metadata: { name },
    });
    return view;
  });
  revalidateView(surface, created.id);
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const path = surface === "pulse" ? `/admin/dashboards/${created.id}` : `/canvas/${created.id}`;
  redirect(tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path }));
}

export async function updateAnalyticsViewAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const viewId = uuidValue(formData, "viewId", "view");
  const visibility = surface === "pulse"
    ? "tenant"
    : enumValue(formData, "visibility", VISIBILITIES, "visibility");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await updateAnalyticsView(client, {
      tenantId: ctx.tenant.id,
      viewId,
      name: textValue(formData, "name", "Name", 120),
      description: textValue(formData, "description", "Description", 500, false),
      visibility,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: `${surface}.view_updated`, targetType: "analytics_view", targetId: viewId });
  });
  revalidateView(surface, viewId);
}

export async function setAnalyticsViewGrantAction(formData: FormData): Promise<void> {
  const ctx = await requireAnalyticsAccess("canvas", true);
  const viewId = uuidValue(formData, "viewId", "board");
  const type = enumValue(formData, "grantType", ANALYTICS_GRANT_TYPES, "sharing target");
  const permission = enumValue(formData, "permission", ANALYTICS_GRANT_PERMISSIONS, "permission");
  const targetId = textValue(formData, "targetId", "Sharing target", 100);
  if (type !== "role" && !UUID_PATTERN.test(targetId)) throw new Error("Choose a valid sharing target.");

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const grant = await setAnalyticsViewGrant(client, {
      tenantId: ctx.tenant.id,
      viewId,
      actorUserId: ctx.profileId,
      type,
      targetId,
      permission,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "canvas.sharing_rule_set",
      targetType: "analytics_view_grant",
      targetId: grant.id,
      metadata: { viewId, granteeType: type, permission },
    });
  });
  revalidateView("canvas", viewId);
}

export async function removeAnalyticsViewGrantAction(formData: FormData): Promise<void> {
  const ctx = await requireAnalyticsAccess("canvas", true);
  const viewId = uuidValue(formData, "viewId", "board");
  const grantId = uuidValue(formData, "grantId", "sharing rule");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await removeAnalyticsViewGrant(client, {
      tenantId: ctx.tenant.id,
      viewId,
      grantId,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "canvas.sharing_rule_removed",
      targetType: "analytics_view_grant",
      targetId: grantId,
      metadata: { viewId },
    });
  });
  revalidateView("canvas", viewId);
}

export async function duplicateAnalyticsViewAction(formData: FormData): Promise<void> {
  const ctx = await requireAnalyticsAccess("canvas", true);
  const sourceViewId = uuidValue(formData, "viewId", "board");
  const created = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const copy = await duplicateAnalyticsView(client, {
      tenantId: ctx.tenant.id,
      viewId: sourceViewId,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: "canvas.view_duplicated",
      targetType: "analytics_view",
      targetId: copy.id,
      metadata: { sourceViewId },
    });
    return copy;
  });
  revalidateView("canvas", created.id);
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  redirect(tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: `/canvas/${created.id}` }));
}

export async function addAnalyticsWidgetAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const viewId = uuidValue(formData, "viewId", "view");
  const visualType = enumValue(formData, "visualType", ANALYTICS_VISUAL_TYPES, "visual type");
  const sourceMode = enumValue(formData, "sourceMode", ANALYTICS_SOURCE_MODES, "data shape");
  const width = Number(formData.get("width"));
  if (!WIDTHS.includes(width as (typeof WIDTHS)[number])) throw new Error("Choose a valid visual width.");
  const height = enumValue(formData, "height", ANALYTICS_HEIGHTS, "visual height");
  const staticText = textValue(formData, "staticText", "Text content", 3000, false);
  const metricIds = [...new Set(formData.getAll("metricIds").map(String))];
  if (metricIds.some((id) => !UUID_PATTERN.test(id))) throw new Error("Choose valid governed KPIs.");
  if (visualType === "text" && !staticText) throw new Error("Text panels need content.");
  if (visualType !== "text" && metricIds.length === 0) throw new Error("Choose at least one governed KPI.");
  if (["kpi", "gauge", "heatmap", "bullet"].includes(visualType) && metricIds.length !== 1) throw new Error(`${visualType === "kpi" ? "KPI cards" : visualType === "gauge" ? "Gauges" : visualType === "heatmap" ? "Heatmaps" : "Bullet charts"} use one KPI.`);
  if (visualType === "funnel" && metricIds.length < 2) throw new Error("Funnels need at least two governed KPIs.");
  if (["combo", "scatter"].includes(visualType) && metricIds.length !== 2) throw new Error(`${visualType === "combo" ? "Line + column charts" : "Scatter plots"} use exactly two governed KPIs.`);
  if (visualType === "radar" && metricIds.length < 3) throw new Error("Radar charts need at least three governed KPIs.");
  if (visualType === "waterfall" && metricIds.length < 2) throw new Error("Waterfalls need at least two contributions.");
  if (visualType === "heatmap" && sourceMode !== "children") throw new Error("Heatmaps compare child teams or departments.");

  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    const widget = await addAnalyticsWidget(client, {
      tenantId: ctx.tenant.id,
      viewId,
      title: textValue(formData, "title", "Title", 120),
      subtitle: textValue(formData, "subtitle", "Subtitle", 240, false),
      visualType,
      sourceMode,
      width,
      height,
      staticText,
      metricIds,
      actorUserId: ctx.profileId,
    });
    await insertAuditLog(client, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.profileId,
      action: `${surface}.visual_added`,
      targetType: "analytics_widget",
      targetId: widget.id,
      metadata: { viewId, visualType, metricCount: metricIds.length },
    });
  });
  revalidateView(surface, viewId);
}

export async function publishAnalyticsViewAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const viewId = uuidValue(formData, "viewId", "view");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await publishAnalyticsView(client, { tenantId: ctx.tenant.id, viewId, actorUserId: ctx.profileId, makeDefault: surface === "pulse" });
    await insertAuditLog(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: `${surface}.view_published`, targetType: "analytics_view", targetId: viewId });
  });
  revalidateView(surface, viewId);
}

export async function removeAnalyticsWidgetAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const viewId = uuidValue(formData, "viewId", "view");
  const widgetId = uuidValue(formData, "widgetId", "visual");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
    await removeAnalyticsWidget(client, { tenantId: ctx.tenant.id, viewId, widgetId, actorUserId: ctx.profileId });
    await insertAuditLog(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId, action: `${surface}.visual_removed`, targetType: "analytics_widget", targetId: widgetId, metadata: { viewId } });
  });
  revalidateView(surface, viewId);
}

export async function moveAnalyticsWidgetAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const viewId = uuidValue(formData, "viewId", "view");
  const widgetId = uuidValue(formData, "widgetId", "visual");
  const direction = enumValue(formData, "direction", ["up", "down"] as const, "direction");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (client) =>
    moveAnalyticsWidget(client, { tenantId: ctx.tenant.id, viewId, widgetId, direction, actorUserId: ctx.profileId }));
  revalidateView(surface, viewId);
}

export async function resizeAnalyticsWidgetAction(formData: FormData): Promise<void> {
  const surface = enumValue(formData, "surface", ANALYTICS_SURFACES, "product area");
  const ctx = await requireAnalyticsAccess(surface, true);
  const viewId = uuidValue(formData, "viewId", "view");
  const widgetId = uuidValue(formData, "widgetId", "visual");
  const width = Number(formData.get("width"));
  if (!WIDTHS.includes(width as (typeof WIDTHS)[number])) throw new Error("Choose a valid visual width.");
  await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (client) =>
    resizeAnalyticsWidget(client, { tenantId: ctx.tenant.id, viewId, widgetId, width, actorUserId: ctx.profileId }));
  revalidateView(surface, viewId);
}
