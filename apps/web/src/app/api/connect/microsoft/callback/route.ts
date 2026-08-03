import { withUserContext } from "@hized/db";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { createMicrosoftConnector } from "@/server/domains/connectors/sharepoint-connectors";
import { getMicrosoftAccount } from "@/server/domains/connectors/microsoft-graph";
import {
  exchangeMicrosoftAuthorizationCode,
  microsoftRedirectUri,
  openMicrosoftOAuthState,
} from "@/server/domains/connectors/microsoft-oauth";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return NextResponse.json({ error: "Microsoft authorization was cancelled or denied." }, { status: 400 });
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  if (!code || !rawState || code.length > 4_096 || rawState.length > 8_192) {
    return NextResponse.json({ error: "The Microsoft authorization callback is incomplete." }, { status: 400 });
  }

  try {
    const state = openMicrosoftOAuthState(rawState);
    const requestHeaders = new Headers(request.headers);
    const ctx = await getAuthContext({ tenantSlug: state.tenantSlug, requestHeaders });
    if (ctx.kind !== "tenant" || ctx.tenant.id !== state.tenantId || ctx.profileId !== state.profileId) {
      return NextResponse.json({ error: "The Microsoft authorization does not match the signed-in tenant user." }, { status: 403 });
    }
    if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
      return NextResponse.json({ error: "Only a company admin or analyst can configure Connect." }, { status: 403 });
    }

    const credentials = await exchangeMicrosoftAuthorizationCode(code, state.codeVerifier);
    const account = await getMicrosoftAccount(credentials.accessToken);
    const created = await withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        const connector = await createMicrosoftConnector(client, {
          tenantId: ctx.tenant.id,
          createdBy: ctx.profileId,
          name: state.connectorName,
          account,
          credentials,
        });
        await insertAuditLog(client, {
          tenantId: ctx.tenant.id,
          actorUserId: ctx.profileId,
          action: "connect.microsoft_authorized",
          targetType: "connector",
          targetId: connector.connectorId,
          metadata: { accountId: account.id, accountEmail: account.email },
        });
        return connector;
      },
    );

    const callback = new URL(microsoftRedirectUri());
    const target = tenantAppUrl({
      slug: ctx.tenant.slug,
      host: callback.host,
      protocol: callback.protocol.replace(":", ""),
      path: `/admin/connect?microsoft=${created.connectorId}`,
    });
    return NextResponse.redirect(new URL(target, callback.origin));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "The Microsoft authorization could not be completed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
