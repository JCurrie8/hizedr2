import { existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, ".env.local");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
