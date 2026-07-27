import { existsSync } from "fs";
import { resolve } from "path";

// Load the repo-root .env.local (MIGRATIONS_DATABASE_URL, DATABASE_URL, ...)
// without adding a dotenv dependency — Node's built-in loader.
const envPath = resolve(__dirname, "../../.env.local");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
