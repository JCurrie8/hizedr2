import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const gatewayConfigSchema = z.object({
  baseUrl: z.string().url(),
  installationId: z.string().uuid(),
  connectorType: z.enum(["sql_server", "azure_sql"]),
  server: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(1433),
  database: z.string().min(1).max(128),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
  pollIntervalSeconds: z.number().int().min(2).max(60).default(5),
  gatewayId: z.string().uuid().optional(),
  connectorId: z.string().uuid().optional(),
  connectorName: z.string().min(1).max(120).optional(),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export interface GatewaySecrets {
  deviceToken: string;
  sqlUsername: string;
  sqlPassword: string;
}

export function configPathFromArgs(args: string[]): string {
  const flag = args.indexOf("--config");
  const configured = flag >= 0 ? args[flag + 1] : undefined;
  return resolve(configured ?? process.env.HIZED_GATEWAY_CONFIG ?? "gateway.config.json");
}

export async function readGatewayConfig(path: string, enrolled: boolean): Promise<GatewayConfig> {
  const parsed = gatewayConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const url = new URL(parsed.baseUrl);
  const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) throw new Error("Gateway baseUrl must use HTTPS.");
  if (enrolled && (!parsed.gatewayId || !parsed.connectorId || !parsed.connectorName)) {
    throw new Error("Gateway configuration is not enrolled.");
  }
  return { ...parsed, baseUrl: url.toString().replace(/\/$/, "") };
}

export async function writeGatewayConfig(path: string, config: GatewayConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(gatewayConfigSchema.parse(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function secretPathForConfig(configPath: string): string {
  return `${configPath}.secrets`;
}
