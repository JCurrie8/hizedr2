import { gatewayCompletionRequestSchema } from "@hized/contracts";
import {
  completeSqlGatewayJob,
  gatewayAuthorizationToken,
} from "@/server/domains/connectors/sql-gateways";
import { readBoundedGatewayJson } from "@/server/domains/connectors/gateway-request";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const deviceToken = gatewayAuthorizationToken(request, "Gateway");
  if (!deviceToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  if (!UUID_PATTERN.test(jobId)) return Response.json({ error: "Invalid job." }, { status: 400 });
  try {
    const completion = gatewayCompletionRequestSchema.parse(await readBoundedGatewayJson(request, 4_000_000));
    await completeSqlGatewayJob(
      deviceToken,
      jobId,
      completion.leaseToken,
      completion.status === "succeeded"
        ? { status: "succeeded", execution: completion.execution }
        : { status: "failed", error: completion.error },
    );
    return Response.json({ accepted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway result was rejected.";
    const invalidLease = /lease|authentication/i.test(message);
    return Response.json(
      { error: invalidLease ? "Gateway job lease is invalid or expired." : message.slice(0, 500) },
      { status: invalidLease ? 409 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
