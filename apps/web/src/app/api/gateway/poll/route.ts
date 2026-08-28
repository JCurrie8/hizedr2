import { GATEWAY_PROTOCOL_VERSION } from "@hized/contracts";
import {
  claimSqlGatewayJob,
  gatewayAuthorizationToken,
} from "@/server/domains/connectors/sql-gateways";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const deviceToken = gatewayAuthorizationToken(request, "Gateway");
  if (!deviceToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const job = await claimSqlGatewayJob(deviceToken);
    return Response.json(
      { protocolVersion: GATEWAY_PROTOCOL_VERSION, job },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Gateway authentication failed." }, { status: 401 });
  }
}
