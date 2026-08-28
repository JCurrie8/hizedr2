#!/usr/bin/env node
import { hostname, platform, release } from "node:os";
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_WORKER_VERSION,
  type GatewayEnrolmentRequest,
} from "@hized/contracts";
import {
  configPathFromArgs,
  readGatewayConfig,
  secretPathForConfig,
  writeGatewayConfig,
  type GatewaySecrets,
} from "./config";
import { completeGatewayJob, enrolGateway, GatewayHttpError, pollGateway } from "./client";
import { protectGatewaySecrets, readGatewaySecrets } from "./secrets";
import { executeLocalSqlAnalysis, inspectLocalSqlProfile } from "./sql";

const command = process.argv[2] ?? "run";
const configPath = configPathFromArgs(process.argv.slice(3));

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for enrolment.`);
  return value;
}

async function enrol(): Promise<void> {
  const config = await readGatewayConfig(configPath, false);
  const enrollmentToken = requiredEnvironment("HIZED_GATEWAY_ENROLMENT_TOKEN");
  const secrets: GatewaySecrets = {
    deviceToken: "pending",
    sqlUsername: requiredEnvironment("HIZED_GATEWAY_SQL_USERNAME"),
    sqlPassword: requiredEnvironment("HIZED_GATEWAY_SQL_PASSWORD"),
  };
  log("Testing the local read-only SQL identity.");
  const profile = await inspectLocalSqlProfile(config, secrets);
  if (profile.database.toLocaleLowerCase("en-GB") !== config.database.toLocaleLowerCase("en-GB")) {
    throw new Error("SQL Server connected to a different database than configured.");
  }
  const request: GatewayEnrolmentRequest = {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    workerVersion: GATEWAY_WORKER_VERSION,
    installationId: config.installationId,
    machineName: hostname(),
    platform: `${platform()} ${release()}`,
    profile: {
      connectorType: config.connectorType,
      server: config.server,
      port: config.port,
      database: profile.database,
      serverVersion: profile.serverVersion,
      catalog: profile.catalog,
    },
  };
  log("Enrolling the outbound gateway with Hized.");
  const enrollment = await enrolGateway(config, enrollmentToken, request);
  await protectGatewaySecrets(secretPathForConfig(configPath), { ...secrets, deviceToken: enrollment.deviceToken });
  await writeGatewayConfig(configPath, {
    ...config,
    gatewayId: enrollment.gatewayId,
    connectorId: enrollment.connectorId,
    connectorName: enrollment.connectorName,
    pollIntervalSeconds: enrollment.pollIntervalSeconds,
  });
  log(`Gateway enrolled for connection ${enrollment.connectorName}. No SQL credential was sent to Hized.`);
}

let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run(): Promise<void> {
  const config = await readGatewayConfig(configPath, true);
  const secrets = await readGatewaySecrets(secretPathForConfig(configPath));
  log(`Gateway ${config.gatewayId} started; outbound HTTPS polling only.`);
  let transientFailures = 0;
  while (!stopping) {
    try {
      const response = await pollGateway(config, secrets.deviceToken);
      transientFailures = 0;
      const job = response.job;
      if (!job) {
        await wait(config.pollIntervalSeconds * 1_000);
        continue;
      }
      log(`Claimed ${job.kind} job ${job.id}.`);
      try {
        const execution = await executeLocalSqlAnalysis(config, secrets, job.payload.sqlText, job.payload.maxRows);
        await completeGatewayJob(config, secrets.deviceToken, {
          jobId: job.id,
          leaseToken: job.leaseToken,
          status: "succeeded",
          execution,
        });
        log(`Completed job ${job.id} with ${execution.rows.length} bounded rows.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "SQL analysis failed.";
        await completeGatewayJob(config, secrets.deviceToken, {
          jobId: job.id,
          leaseToken: job.leaseToken,
          status: "failed",
          error: message,
        });
        log(`Job ${job.id} failed: ${message.slice(0, 300)}`);
      }
    } catch (error) {
      if (error instanceof GatewayHttpError && (error.status === 401 || error.status === 403)) {
        throw new Error("Gateway authorization was revoked or expired. Re-enrol this device in Hized.");
      }
      transientFailures += 1;
      const message = error instanceof Error ? error.message : "Gateway polling failed.";
      log(`Poll failed: ${message.slice(0, 300)}`);
      await wait(Math.min(60, 2 ** Math.min(transientFailures, 5)) * 1_000);
    }
  }
  log("Gateway stopped.");
}

async function test(): Promise<void> {
  const config = await readGatewayConfig(configPath, true);
  const secrets = await readGatewaySecrets(secretPathForConfig(configPath));
  const profile = await inspectLocalSqlProfile(config, secrets);
  log(`Read-only SQL test passed for ${profile.database}; ${profile.catalog.length} visible tables/views.`);
  const response = await pollGateway(config, secrets.deviceToken);
  log(`Hized gateway authentication passed${response.job ? "; one queued job is available" : ""}.`);
}

async function main(): Promise<void> {
  if (command === "enrol") return enrol();
  if (command === "run") return run();
  if (command === "test") return test();
  throw new Error("Usage: node index.js <enrol|run|test> --config <path>");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Gateway failed.";
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  process.exitCode = 1;
});
