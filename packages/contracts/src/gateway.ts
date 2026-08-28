import { z } from "zod";
import { MAX_SQL_ANALYSIS_ROWS, sqlAnalysisExecutionSchema } from "./sql-analysis";

export const GATEWAY_PROTOCOL_VERSION = 1;
export const GATEWAY_WORKER_VERSION = "0.1.0";

export const gatewayCatalogEntrySchema = z.object({
  schema: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  objectType: z.enum(["table", "view"]),
});

export const gatewayEnrolmentRequestSchema = z.object({
  protocolVersion: z.literal(GATEWAY_PROTOCOL_VERSION),
  workerVersion: z.string().min(1).max(40),
  installationId: z.string().uuid(),
  machineName: z.string().min(1).max(160),
  platform: z.string().min(1).max(120),
  profile: z.object({
    connectorType: z.enum(["sql_server", "azure_sql"]),
    server: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    database: z.string().min(1).max(128),
    serverVersion: z.string().min(1).max(128),
    catalog: z.array(gatewayCatalogEntrySchema).max(2_000),
  }),
});

export const gatewayEnrolmentResponseSchema = z.object({
  gatewayId: z.string().uuid(),
  connectorId: z.string().uuid(),
  connectorName: z.string().min(1).max(120),
  deviceToken: z.string().min(43).max(200),
  pollIntervalSeconds: z.number().int().min(2).max(60),
});

export const gatewayPollResponseSchema = z.object({
  protocolVersion: z.literal(GATEWAY_PROTOCOL_VERSION),
  job: z.object({
    id: z.string().uuid(),
    leaseToken: z.string().min(43).max(200),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    kind: z.literal("sql_analysis"),
    payload: z.object({
      sqlText: z.string().min(8).max(50_000),
      maxRows: z.number().int().min(1).max(MAX_SQL_ANALYSIS_ROWS),
    }),
  }).nullable(),
});

export const gatewayCompletionRequestSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    leaseToken: z.string().min(43).max(200),
    execution: sqlAnalysisExecutionSchema,
  }),
  z.object({
    status: z.literal("failed"),
    leaseToken: z.string().min(43).max(200),
    error: z.string().min(1).max(500),
  }),
]);

export type GatewayEnrolmentRequest = z.infer<typeof gatewayEnrolmentRequestSchema>;
export type GatewayEnrolmentResponse = z.infer<typeof gatewayEnrolmentResponseSchema>;
export type GatewayPollResponse = z.infer<typeof gatewayPollResponseSchema>;
export type GatewayCompletionRequest = z.infer<typeof gatewayCompletionRequestSchema>;
