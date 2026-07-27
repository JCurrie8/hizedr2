#!/usr/bin/env node
// Minimal, dependency-light migration runner: applies /db/migrations/*.sql
// in filename order, tracked in a public._migrations table. Idempotent —
// safe to run repeatedly; already-applied files are skipped.
import { Pool } from "@neondatabase/serverless";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "migrations");

// Migrations run DDL and role grants, so they need the owner connection
// (neondb_owner), not the app's restricted app_user role.
const connectionString = process.env.MIGRATIONS_DATABASE_URL;
if (!connectionString) {
  console.error("MIGRATIONS_DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function main() {
  await pool.query(`
    create table if not exists public._migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const { rows: applied } = await pool.query("select filename from public._migrations");
  const appliedSet = new Set(applied.map((r) => r.filename));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`apply ${file}`);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into public._migrations (filename) values ($1)", [file]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error(`FAILED ${file}:`, err.message);
      process.exitCode = 1;
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("done");
}

main()
  .catch(() => { process.exitCode = 1; })
  .finally(() => pool.end());
