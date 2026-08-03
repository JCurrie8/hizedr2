import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { getDraftBranding, getPublishedBranding } from "@/server/domains/branding/branding";
import { downloadR2Object } from "@/server/storage/r2";

export async function GET(request: Request) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return new Response("Not found", { status: 404 });
  const draftRequested = new URL(request.url).searchParams.get("draft") === "1";
  if (draftRequested && ctx.role !== "company_admin") return new Response("Not found", { status: 404 });

  const theme = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => draftRequested
      ? getDraftBranding(client, { tenantId: ctx.tenant.id })
      : getPublishedBranding(client, { tenantId: ctx.tenant.id }),
  );
  if (!theme.logoObjectKey || !theme.logoContentType) return new Response("Not found", { status: 404 });
  const requiredPrefix = `${ctx.tenant.id}/branding/drafts/`;
  if (!theme.logoObjectKey.startsWith(requiredPrefix) || theme.logoObjectKey.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  const bytes = await downloadR2Object(theme.logoObjectKey);
  const body = bytes.slice().buffer as ArrayBuffer;
  return new Response(new Blob([body], { type: theme.logoContentType }), {
    headers: {
      "cache-control": draftRequested ? "private, no-store" : "private, max-age=300",
      "content-type": theme.logoContentType,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    },
  });
}
