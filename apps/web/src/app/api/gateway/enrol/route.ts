import { gatewayEnrolmentRequestSchema } from "@hized/contracts";
import {
  enrolSqlGateway,
  gatewayAuthorizationToken,
} from "@/server/domains/connectors/sql-gateways";
import { readBoundedGatewayJson } from "@/server/domains/connectors/gateway-request";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const enrollmentToken = gatewayAuthorizationToken(request, "Enrolment");
  if (!enrollmentToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const input = gatewayEnrolmentRequestSchema.parse(await readBoundedGatewayJson(request, 1_000_000));
    const result = await enrolSqlGateway(enrollmentToken, input);
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway enrolment failed.";
    const invalidToken = /invalid|expired|already used/i.test(message);
    return Response.json(
      { error: invalidToken ? "Gateway enrolment is invalid or expired." : message.slice(0, 500) },
      { status: invalidToken ? 401 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
