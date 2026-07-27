#!/usr/bin/env node
// One-time (idempotent) setup: creates a restricted `app_user` Postgres
// role WITHOUT bypassrls, grants it exactly the privileges the running
// app needs, and prints the resulting connection string. `neondb_owner`
// (the only role in Neon's default connection string) has BYPASSRLS=true,
// which makes every RLS policy in 0003_rls.sql a no-op if the app
// connects as that role — this role is how the app actually gets
// isolation enforcement. Only migrations should use the owner connection.
import { Pool } from "@neondatabase/serverless";
import { randomBytes } from "crypto";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("MIGRATIONS_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: adminUrl });
const password = randomBytes(24).toString("base64url");

async function main() {
  const { rows } = await pool.query("select 1 from pg_roles where rolname = 'app_user'");
  if (rows.length === 0) {
    // Password can't be parameterized in DDL; it's freshly generated here, not user input.
    await pool.query(`create role app_user with login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls`);
    console.log("created role app_user");
  } else {
    await pool.query(`alter role app_user with password '${password}'`);
    console.log("role app_user already existed — rotated password");
  }

  await pool.query("grant connect on database neondb to app_user");
  await pool.query("grant usage on schema public to app_user");
  await pool.query("grant select, insert, update, delete on all tables in schema public to app_user");
  await pool.query("grant usage, select on all sequences in schema public to app_user");
  await pool.query("grant execute on all functions in schema public to app_user");
  // Keep future tables/sequences/functions covered without re-running this manually.
  await pool.query("alter default privileges in schema public grant select, insert, update, delete on tables to app_user");
  await pool.query("alter default privileges in schema public grant usage, select on sequences to app_user");
  await pool.query("alter default privileges in schema public grant execute on functions to app_user");
  // audit_log's own revoke (0002) is broader than public — re-assert app_user still can't update/delete it.
  await pool.query("revoke update, delete on public.audit_log from app_user");

  const url = new URL(adminUrl);
  url.username = "app_user";
  url.password = password;
  console.log("\nSet this as DATABASE_URL (the app's restricted, RLS-enforcing connection):\n");
  console.log(url.toString());
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
