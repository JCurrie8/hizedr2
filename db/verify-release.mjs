#!/usr/bin/env node
import { Pool } from "@neondatabase/serverless";

const connectionString = process.env.MIGRATIONS_DATABASE_URL;
const expectedMigration = process.argv.slice(2).find((argument) => argument !== "--");

if (!connectionString) {
  console.error("MIGRATIONS_DATABASE_URL is not set");
  process.exit(1);
}
if (!expectedMigration) {
  console.error("Pass the exact migration filename to verify");
  process.exit(1);
}

const verifiers = {
  "0035_governed_record_projection_rules.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations
          where filename = $1) as ledger,
        (select relrowsecurity from pg_class
          where oid = 'public.governed_record_projection_rules'::regclass) as rls,
        (select count(*)::integer from pg_policies
          where schemaname = 'public'
            and tablename = 'governed_record_projection_rules') as policies,
        (select count(*)::integer from pg_policies
          where schemaname = 'public'
            and tablename = 'governed_datasets') as dataset_policies,
        (select count(*)::integer from information_schema.columns
          where table_schema = 'public'
            and table_name = 'governed_dataset_fields'
            and column_name = 'source_field') as source_col,
        has_function_privilege(
          'app_user',
          'public.can_read_governed_dataset_row(uuid,text)',
          'execute'
        ) as app_user_exec,
        has_function_privilege(
          'public',
          'public.can_read_governed_dataset_row(uuid,text)',
          'execute'
        ) as public_exec
    `,
    expected: {
      ledger: 1,
      rls: true,
      policies: 4,
      dataset_policies: 4,
      source_col: 1,
      app_user_exec: true,
      public_exec: false,
    },
  },
  "0036_sql_workbench_destinations.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations
          where filename = $1) as ledger,
        (select relrowsecurity from pg_class
          where oid = 'public.pipeline_sql_destinations'::regclass) as destination_rls,
        (select relrowsecurity from pg_class
          where oid = 'public.pipeline_sql_destination_runs'::regclass) as run_rls,
        (select count(*)::integer from pg_policies
          where schemaname = 'public'
            and tablename = 'pipeline_sql_destinations') as destination_policies,
        (select count(*)::integer from pg_policies
          where schemaname = 'public'
            and tablename = 'pipeline_sql_destination_runs') as run_policies,
        has_function_privilege(
          'app_user',
          'public.validate_pipeline_sql_destination()',
          'execute'
        ) as app_user_exec,
        has_function_privilege(
          'public',
          'public.validate_pipeline_sql_destination()',
          'execute'
        ) as public_exec,
        has_function_privilege(
          'app_user',
          'public.validate_pipeline_sql_destination_run()',
          'execute'
        ) as run_app_user_exec,
        has_function_privilege(
          'public',
          'public.validate_pipeline_sql_destination_run()',
          'execute'
        ) as run_public_exec
    `,
    expected: {
      ledger: 1,
      destination_rls: true,
      run_rls: true,
      destination_policies: 1,
      run_policies: 1,
      app_user_exec: true,
      public_exec: false,
      run_app_user_exec: true,
      run_public_exec: false,
    },
  },
};

const verifier = verifiers[expectedMigration];
if (!verifier) {
  console.error(`No production verifier is registered for ${expectedMigration}`);
  process.exit(1);
}

const pool = new Pool({ connectionString });

try {
  const { rows: [actual] } = await pool.query(verifier.query, [expectedMigration]);
  const mismatches = Object.entries(verifier.expected)
    .filter(([key, expected]) => actual?.[key] !== expected)
    .map(([key, expected]) => `${key}: expected ${expected}, received ${actual?.[key]}`);

  if (mismatches.length > 0) {
    console.error("Production verification failed:");
    for (const mismatch of mismatches) console.error(`- ${mismatch}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified release invariants for ${expectedMigration}.`);
    for (const [key, value] of Object.entries(actual)) console.log(`${key}=${value}`);
  }
} finally {
  await pool.end();
}
