import { createHash, randomBytes } from "node:crypto";
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_WORKER_VERSION,
  MAX_SQL_ANALYSIS_ROWS,
  gatewayEnrolmentRequestSchema,
  sqlAnalysisExecutionSchema,
  type SqlAnalysisExecution,
} from "@hized/contracts";
import { withUserContext } from "@hized/db";
import type { PoolClient } from "@neondatabase/serverless";
import { insertAuditLog } from "../access-control/audit";
import { saveSqlAnalysisExecution, recordSqlAnalysisFailure } from "../analytics/sql-analysis";
import { dbPool } from "../../db-pool";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,200}$/;

export interface SqlGatewayOverview {
  id: string;
  name: string;
  connectorName: string;
  connectorId: string | null;
  status: "pending" | "enrolling" | "active" | "error" | "revoked";
  machineName: string | null;
  platform: string | null;
  workerVersion: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  enrollmentExpiresAt: string;
  server: string | null;
  database: string | null;
}

export interface GatewayEnrollment {
  gatewayId: string;
  token: string;
  expiresAt: string;
}

interface GatewayJobAuthority {
  tenantId: string;
  actorUserId: string;
  queryId: string;
  connectorId: string;
  gatewayId: string;
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashGatewayToken(purpose: "enrollment" | "device" | "lease", rawToken: string): string {
  if (!TOKEN_PATTERN.test(rawToken)) throw new Error("Gateway token format is invalid.");
  return createHash("sha256").update(`hized:gateway:${purpose}:v1:${rawToken}`).digest("hex");
}

export function gatewayAuthorizationToken(request: Request, scheme: "Enrolment" | "Gateway"): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const [suppliedScheme, suppliedToken, extra] = authorization.split(/\s+/);
  if (extra || suppliedScheme !== scheme || !suppliedToken || !TOKEN_PATTERN.test(suppliedToken)) return null;
  return suppliedToken;
}

export async function createSqlGatewayEnrollment(
  client: PoolClient,
  input: { tenantId: string; name: string; connectorName: string; actorUserId: string },
): Promise<GatewayEnrollment> {
  const enrollmentToken = token("hze");
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const { rows: [row] } = await client.query(
    "select public.create_connector_gateway_enrollment($1,$2,$3,$4,$5,$6) as id",
    [
      input.tenantId,
      input.name,
      input.connectorName,
      hashGatewayToken("enrollment", enrollmentToken),
      expiresAt,
      input.actorUserId,
    ],
  );
  if (!row?.id) throw new Error("The gateway enrolment could not be created.");
  return { gatewayId: row.id, token: enrollmentToken, expiresAt };
}

export async function listSqlGateways(
  client: PoolClient,
  input: { tenantId: string },
): Promise<SqlGatewayOverview[]> {
  const { rows } = await client.query(
    `select gateway.id, gateway.name, gateway.connector_name, gateway.connector_id,
            gateway.status, gateway.machine_name, gateway.platform, gateway.worker_version,
            gateway.last_seen_at, gateway.last_error, gateway.enrollment_expires_at,
            connector.config ->> 'server' as server,
            connector.config ->> 'database' as database
       from public.connector_gateways gateway
       left join public.connectors connector
         on connector.id = gateway.connector_id and connector.tenant_id = gateway.tenant_id
      where gateway.tenant_id = $1
      order by gateway.created_at desc`,
    [input.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    connectorName: row.connector_name,
    connectorId: row.connector_id,
    status: row.status,
    machineName: row.machine_name,
    platform: row.platform,
    workerVersion: row.worker_version,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    lastError: row.last_error,
    enrollmentExpiresAt: new Date(row.enrollment_expires_at).toISOString(),
    server: row.server,
    database: row.database,
  }));
}

export async function revokeSqlGateway(
  client: PoolClient,
  input: { tenantId: string; gatewayId: string; actorUserId: string },
): Promise<void> {
  await client.query("select public.revoke_connector_gateway($1,$2,$3)", [
    input.tenantId,
    input.gatewayId,
    input.actorUserId,
  ]);
}

export async function enrolSqlGateway(rawToken: string, rawInput: unknown) {
  const input = gatewayEnrolmentRequestSchema.parse(rawInput);
  const enrollmentHash = hashGatewayToken("enrollment", rawToken);
  const { rows: [authority] } = await dbPool.query(
    "select * from public.begin_connector_gateway_enrollment($1)",
    [enrollmentHash],
  );
  if (!authority) throw new Error("Gateway enrolment is invalid, expired or already used.");
  const deviceToken = token("hzd");
  const deviceHash = hashGatewayToken("device", deviceToken);
  try {
    const connectorId = await withUserContext(
      { userId: authority.actor_user_id, tenantId: authority.tenant_id },
      async (client) => {
        const config = {
          server: input.profile.server,
          port: input.profile.port,
          database: input.profile.database,
          serverVersion: input.profile.serverVersion,
          direction: "source",
          networkMode: "gateway",
          gatewayId: authority.gateway_id,
          tls: { localNetwork: true },
          catalog: input.profile.catalog,
          catalogRefreshedAt: new Date().toISOString(),
        };
        const { rows: [connector] } = await client.query(
          `insert into public.connectors
             (tenant_id, connector_type, name, status, auth_mode, config, created_by,
              last_tested_at, last_test_status, last_test_message)
           values ($1,$2,$3,'active','none',$4::jsonb,$5,now(),'succeeded',
                   'Outbound gateway verified a local read-only SQL login')
           returning id`,
          [
            authority.tenant_id,
            input.profile.connectorType,
            authority.connector_name,
            JSON.stringify(config),
            authority.actor_user_id,
          ],
        );
        await client.query(
          "select public.complete_connector_gateway_enrollment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [
            authority.gateway_id,
            enrollmentHash,
            deviceHash,
            connector.id,
            input.installationId,
            input.machineName,
            input.platform,
            input.workerVersion,
            input.protocolVersion,
            JSON.stringify({ sqlAnalysis: true, maxRows: MAX_SQL_ANALYSIS_ROWS }),
          ],
        );
        await insertAuditLog(client, {
          tenantId: authority.tenant_id,
          actorUserId: authority.actor_user_id,
          action: "connect.gateway_enrolled",
          targetType: "connector_gateway",
          targetId: authority.gateway_id,
          metadata: {
            connectorId: connector.id,
            installationId: input.installationId,
            machineName: input.machineName,
            server: input.profile.server,
            database: input.profile.database,
            protocolVersion: input.protocolVersion,
          },
        });
        return connector.id as string;
      },
    );
    return {
      gatewayId: authority.gateway_id as string,
      connectorId,
      connectorName: authority.connector_name as string,
      deviceToken,
      pollIntervalSeconds: 5,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway enrolment failed.";
    await dbPool.query("select public.fail_connector_gateway_enrollment($1,$2,$3)", [
      authority.gateway_id,
      enrollmentHash,
      message,
    ]).catch(() => {});
    throw error;
  }
}

export async function enqueueSqlAnalysisGatewayJob(
  client: PoolClient,
  input: { tenantId: string; queryId: string; actorUserId: string },
): Promise<string> {
  const { rows: [row] } = await client.query(
    "select public.enqueue_connector_gateway_sql_analysis($1,$2,$3) as id",
    [input.tenantId, input.queryId, input.actorUserId],
  );
  if (!row?.id) throw new Error("The SQL gateway job could not be queued.");
  return row.id;
}

export async function claimSqlGatewayJob(rawDeviceToken: string) {
  const leaseToken = token("hzl");
  const deviceHash = hashGatewayToken("device", rawDeviceToken);
  const { rows: [authentication] } = await dbPool.query(
    "select public.authenticate_connector_gateway_device($1) as authenticated",
    [deviceHash],
  );
  if (authentication?.authenticated !== true) throw new Error("Gateway authentication failed.");
  const { rows: [job] } = await dbPool.query(
    "select * from public.claim_connector_gateway_job($1,$2)",
    [deviceHash, hashGatewayToken("lease", leaseToken)],
  );
  if (!job) return null;
  return {
    id: job.job_id as string,
    leaseToken,
    leaseExpiresAt: new Date(job.lease_expires_at).toISOString(),
    kind: "sql_analysis" as const,
    payload: { sqlText: job.sql_text as string, maxRows: Number(job.max_rows) },
  };
}

async function gatewayJobAuthority(
  rawDeviceToken: string,
  jobId: string,
  rawLeaseToken: string,
): Promise<GatewayJobAuthority> {
  const { rows: [row] } = await dbPool.query(
    "select * from public.authenticate_connector_gateway_job_result($1,$2,$3)",
    [
      hashGatewayToken("device", rawDeviceToken),
      jobId,
      hashGatewayToken("lease", rawLeaseToken),
    ],
  );
  if (!row) throw new Error("Gateway job lease is invalid or expired.");
  return {
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    queryId: row.query_id,
    connectorId: row.connector_id,
    gatewayId: row.gateway_id,
  };
}

export async function completeSqlGatewayJob(
  rawDeviceToken: string,
  jobId: string,
  rawLeaseToken: string,
  outcome: { status: "succeeded"; execution: SqlAnalysisExecution } | { status: "failed"; error: string },
): Promise<void> {
  const authority = await gatewayJobAuthority(rawDeviceToken, jobId, rawLeaseToken);
  const deviceHash = hashGatewayToken("device", rawDeviceToken);
  const leaseHash = hashGatewayToken("lease", rawLeaseToken);
  await withUserContext(
    { userId: authority.actorUserId, tenantId: authority.tenantId },
    async (client) => {
      if (outcome.status === "succeeded") {
        const execution = sqlAnalysisExecutionSchema.parse(outcome.execution);
        await saveSqlAnalysisExecution(client, {
          tenantId: authority.tenantId,
          queryId: authority.queryId,
          actorUserId: authority.actorUserId,
          execution,
        });
        await client.query(
          "select public.finish_connector_gateway_job($1,$2,$3,$4,'succeeded',$5,null,$6)",
          [authority.tenantId, jobId, deviceHash, leaseHash, execution.rows.length, authority.actorUserId],
        );
        await insertAuditLog(client, {
          tenantId: authority.tenantId,
          actorUserId: authority.actorUserId,
          action: "analytics.sql_query_run",
          targetType: "sql_analysis_query",
          targetId: authority.queryId,
          metadata: {
            connectorId: authority.connectorId,
            gatewayId: authority.gatewayId,
            gatewayJobId: jobId,
            rowCount: execution.rows.length,
          },
        });
      } else {
        const message = outcome.error.slice(0, 500);
        await recordSqlAnalysisFailure(client, {
          tenantId: authority.tenantId,
          queryId: authority.queryId,
          actorUserId: authority.actorUserId,
          message,
        });
        await client.query(
          "select public.finish_connector_gateway_job($1,$2,$3,$4,'failed',null,$5,$6)",
          [authority.tenantId, jobId, deviceHash, leaseHash, message, authority.actorUserId],
        );
        await insertAuditLog(client, {
          tenantId: authority.tenantId,
          actorUserId: authority.actorUserId,
          action: "analytics.sql_query_failed",
          targetType: "sql_analysis_query",
          targetId: authority.queryId,
          metadata: { connectorId: authority.connectorId, gatewayId: authority.gatewayId, gatewayJobId: jobId },
        });
      }
    },
  );
}

export const gatewayServerCapabilities = {
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  minimumWorkerVersion: GATEWAY_WORKER_VERSION,
};
