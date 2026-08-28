import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { GatewaySecrets } from "./config";

const secretSchema = z.object({
  deviceToken: z.string().min(43).max(200),
  sqlUsername: z.string().min(1).max(256),
  sqlPassword: z.string().min(1).max(1024),
});

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`Windows secret protection failed (${code ?? "unknown"}): ${stderr.slice(0, 300)}`)));
    child.stdin.end(input, "utf8");
  });
}

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$plain = [Console]::In.ReadToEnd()",
  "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
  "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)",
  "[Convert]::ToBase64String($protected)",
].join("; ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$encoded = [Console]::In.ReadToEnd().Trim()",
  "$protected = [Convert]::FromBase64String($encoded)",
  "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)",
  "[Text.Encoding]::UTF8.GetString($plain)",
].join("; ");

export async function protectGatewaySecrets(path: string, secrets: GatewaySecrets): Promise<void> {
  if (process.platform !== "win32") throw new Error("Production gateway secrets require Windows DPAPI.");
  const protectedValue = await runPowerShell(PROTECT_SCRIPT, JSON.stringify(secretSchema.parse(secrets)));
  await writeFile(path, `${protectedValue}\n`, { encoding: "ascii", mode: 0o600 });
}

export async function readGatewaySecrets(path: string): Promise<GatewaySecrets> {
  if (process.platform !== "win32") throw new Error("Production gateway secrets require Windows DPAPI.");
  const protectedValue = await readFile(path, "ascii");
  return secretSchema.parse(JSON.parse(await runPowerShell(UNPROTECT_SCRIPT, protectedValue)));
}
