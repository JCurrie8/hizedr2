import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSqlAnalysisExecution, validateSqlAnalysisText } from "@hized/contracts";
import type { GatewayConfig } from "./config";
import { enrolGateway, GatewayHttpError, pollGateway } from "./client";
import { protectGatewaySecrets, readGatewaySecrets } from "./secrets";

const config: GatewayConfig = {
  baseUrl: "https://hized.app",
  installationId: "10000000-0000-4000-8000-000000000001",
  connectorType: "sql_server",
  server: "localhost",
  port: 1433,
  database: "Activ8",
  encrypt: true,
  trustServerCertificate: false,
  pollIntervalSeconds: 5,
};

describe("gateway protocol", () => {
  it("enrols without putting a SQL credential in the request body", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Enrolment /) });
      const body = String(init?.body);
      expect(body).not.toMatch(/password|username|credential/i);
      return Response.json({
        gatewayId: "10000000-0000-4000-8000-000000000002",
        connectorId: "10000000-0000-4000-8000-000000000003",
        connectorName: "Activ8 private SQL",
        deviceToken: `hzd_${"a".repeat(43)}`,
        pollIntervalSeconds: 5,
      }, { status: 201 });
    });
    const result = await enrolGateway(config, `hze_${"b".repeat(43)}`, {
      protocolVersion: 1,
      workerVersion: "0.1.0",
      installationId: config.installationId,
      machineName: "ACTIV8-SQL",
      platform: "win32",
      profile: {
        connectorType: "sql_server",
        server: "localhost",
        port: 1433,
        database: "Activ8",
        serverVersion: "16.0",
        catalog: [{ schema: "reporting", name: "Jobs", objectType: "view" }],
      },
    }, fetcher as typeof fetch);
    expect(result.connectorName).toBe("Activ8 private SQL");
  });

  it("accepts an empty authenticated poll and rejects malformed protocol data", async () => {
    const valid = vi.fn(async () => Response.json({ protocolVersion: 1, job: null }));
    await expect(pollGateway(config, `hzd_${"c".repeat(43)}`, valid as typeof fetch)).resolves.toEqual({ protocolVersion: 1, job: null });
    const invalid = vi.fn(async () => Response.json({ protocolVersion: 99, job: null }));
    await expect(pollGateway(config, `hzd_${"c".repeat(43)}`, invalid as typeof fetch)).rejects.toThrow();
  });

  it("preserves an authorization status so a revoked worker can stop polling", async () => {
    const revoked = vi.fn(async () => Response.json({ error: "Gateway authentication failed." }, { status: 401 }));
    const error = await pollGateway(config, `hzd_${"c".repeat(43)}`, revoked as typeof fetch).catch((value) => value);
    expect(error).toBeInstanceOf(GatewayHttpError);
    expect(error).toMatchObject({ status: 401, message: "Gateway authentication failed." });
  });
});

describe("shared SQL analysis guard", () => {
  it("refuses write and external-execution statements on the worker too", () => {
    expect(() => validateSqlAnalysisText("delete from reporting.Jobs")).toThrow(/SELECT or CTE/);
    expect(() => validateSqlAnalysisText("select * from openrowset('provider','source','query')")).toThrow(/OPENROWSET/);
  });

  it("normalizes a bounded organisation-scoped result", () => {
    const execution = normalizeSqlAnalysisExecution([{
      org_code: "TEAM_A",
      series_key: "jobs_completed",
      series_label: "Jobs completed",
      period_start: new Date("2026-07-01T00:00:00.000Z"),
      period_end: new Date("2026-08-01T00:00:00.000Z"),
      actual_value: 42,
    }], [
      { name: "org_code", sqlType: "NVarChar" },
      { name: "series_key", sqlType: "NVarChar" },
      { name: "series_label", sqlType: "NVarChar" },
      { name: "period_start", sqlType: "Date" },
      { name: "period_end", sqlType: "Date" },
      { name: "actual_value", sqlType: "Int" },
    ], "2026-08-01T06:00:00.000Z");
    expect(execution.rows[0]).toMatchObject({ orgCode: "TEAM_A", actualValue: 42, sourceRefreshedAt: "2026-08-01T06:00:00.000Z" });
  });
});

describe("Windows credential protection", () => {
  it.runIf(process.platform === "win32")("round-trips gateway secrets through LocalMachine DPAPI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hized-gateway-dpapi-"));
    const secretPath = join(directory, "gateway.config.json.secrets");
    try {
      const secrets = {
        deviceToken: `hzd_${"d".repeat(43)}`,
        sqlUsername: "hized_reader",
        sqlPassword: "local-test-secret",
      };
      await protectGatewaySecrets(secretPath, secrets);
      await expect(readGatewaySecrets(secretPath)).resolves.toEqual(secrets);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
