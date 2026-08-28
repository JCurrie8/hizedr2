import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_WORKER_VERSION,
  gatewayEnrolmentResponseSchema,
  gatewayPollResponseSchema,
  type GatewayEnrolmentRequest,
  type GatewayEnrolmentResponse,
  type GatewayPollResponse,
  type SqlAnalysisExecution,
} from "@hized/contracts";
import type { GatewayConfig } from "./config";

async function responseJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error(`Hized returned HTTP ${response.status} without JSON.`);
  return response.json();
}

async function errorMessage(response: Response): Promise<string> {
  const body = await responseJson(response).catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error.slice(0, 500) : `Hized returned HTTP ${response.status}.`;
}

export class GatewayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

async function assertSuccessful(response: Response): Promise<void> {
  if (!response.ok) throw new GatewayHttpError(response.status, await errorMessage(response));
}

export async function enrolGateway(
  config: GatewayConfig,
  enrollmentToken: string,
  request: GatewayEnrolmentRequest,
  fetcher: typeof fetch = fetch,
): Promise<GatewayEnrolmentResponse> {
  const response = await fetcher(`${config.baseUrl}/api/gateway/enrol`, {
    method: "POST",
    headers: { "Authorization": `Enrolment ${enrollmentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000),
  });
  await assertSuccessful(response);
  return gatewayEnrolmentResponseSchema.parse(await responseJson(response));
}

export async function pollGateway(
  config: GatewayConfig,
  deviceToken: string,
  fetcher: typeof fetch = fetch,
): Promise<GatewayPollResponse> {
  const response = await fetcher(`${config.baseUrl}/api/gateway/poll`, {
    method: "POST",
    headers: { "Authorization": `Gateway ${deviceToken}`, "X-Hized-Gateway-Version": GATEWAY_WORKER_VERSION },
    signal: AbortSignal.timeout(30_000),
  });
  await assertSuccessful(response);
  return gatewayPollResponseSchema.parse(await responseJson(response));
}

export async function completeGatewayJob(
  config: GatewayConfig,
  deviceToken: string,
  input: { jobId: string; leaseToken: string } & (
    { status: "succeeded"; execution: SqlAnalysisExecution }
    | { status: "failed"; error: string }
  ),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${config.baseUrl}/api/gateway/jobs/${input.jobId}/complete`, {
    method: "POST",
    headers: {
      "Authorization": `Gateway ${deviceToken}`,
      "Content-Type": "application/json",
      "X-Hized-Gateway-Version": GATEWAY_WORKER_VERSION,
    },
    body: JSON.stringify(input.status === "succeeded"
      ? { status: input.status, leaseToken: input.leaseToken, execution: input.execution }
      : { status: input.status, leaseToken: input.leaseToken, error: input.error.slice(0, 500) }),
    signal: AbortSignal.timeout(60_000),
  });
  await assertSuccessful(response);
}

export const gatewayProtocolVersion = GATEWAY_PROTOCOL_VERSION;
