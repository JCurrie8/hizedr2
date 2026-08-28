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
  "0037_sql_destination_scheduling.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations
          where filename = $1) as ledger,
        (select relrowsecurity from pg_class
          where oid = 'public.pipeline_sql_destinations'::regclass) as rls,
        (select count(*)::integer from pg_policies
          where schemaname = 'public'
            and tablename = 'pipeline_sql_destinations') as policies,
        (select count(*)::integer from information_schema.columns
          where table_schema = 'public'
            and table_name = 'pipeline_sql_destinations'
            and column_name in (
              'schedule_enabled', 'schedule_interval_minutes', 'next_load_at',
              'last_attempt_at', 'last_success_at', 'last_error',
              'consecutive_failures', 'next_retry_at', 'lease_token',
              'lease_expires_at'
            )) as schedule_columns,
        (select count(*)::integer from pg_indexes
          where schemaname = 'public'
            and tablename = 'pipeline_sql_destinations'
            and indexname = 'pipeline_sql_destinations_due_idx') as due_index,
        has_function_privilege(
          'app_user',
          'public.claim_due_sql_destination_syncs(integer)',
          'execute'
        ) as app_user_exec,
        has_function_privilege(
          'public',
          'public.claim_due_sql_destination_syncs(integer)',
          'execute'
        ) as public_exec,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""']
           from pg_proc
          where oid = 'public.claim_due_sql_destination_syncs(integer)'::regprocedure) as fixed_search_path
    `,
    expected: {
      ledger: 1,
      rls: true,
      policies: 1,
      schedule_columns: 10,
      due_index: 1,
      app_user_exec: true,
      public_exec: false,
      fixed_search_path: true,
    },
  },
  "0038_sql_transformation_versions.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations
          where filename = $1) as ledger,
        (select relrowsecurity from pg_class
          where oid = 'public.pipeline_sql_transformation_versions'::regclass) as rls,
        (select count(*)::integer from pg_policies
          where schemaname = 'public'
            and tablename = 'pipeline_sql_transformation_versions') as policies,
        (select count(*)::integer from pg_indexes
          where schemaname = 'public'
            and tablename = 'pipeline_sql_transformation_versions'
            and indexname in (
              'pipeline_sql_transformation_versions_one_approved_idx',
              'pipeline_sql_transformation_versions_tenant_destination_idx'
            )) as indexes,
        has_table_privilege('app_user', 'public.pipeline_sql_transformation_versions', 'select') as app_select,
        has_table_privilege('app_user', 'public.pipeline_sql_transformation_versions', 'insert') as app_insert,
        has_table_privilege('app_user', 'public.pipeline_sql_transformation_versions', 'update') as app_update,
        has_table_privilege('app_user', 'public.pipeline_sql_transformation_versions', 'delete') as app_delete,
        has_function_privilege(
          'app_user',
          'public.create_sql_transformation_version(uuid,uuid,text,text,text,jsonb,text,uuid)',
          'execute'
        ) as create_app_exec,
        has_function_privilege(
          'public',
          'public.create_sql_transformation_version(uuid,uuid,text,text,text,jsonb,text,uuid)',
          'execute'
        ) as create_public_exec,
        has_function_privilege(
          'app_user',
          'public.approve_sql_transformation_version(uuid,uuid,uuid)',
          'execute'
        ) as approve_app_exec,
        has_function_privilege(
          'public',
          'public.approve_sql_transformation_version(uuid,uuid,uuid)',
          'execute'
        ) as approve_public_exec,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""']
           from pg_proc
          where oid = 'public.create_sql_transformation_version(uuid,uuid,text,text,text,jsonb,text,uuid)'::regprocedure) as create_fixed_path,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""']
           from pg_proc
          where oid = 'public.approve_sql_transformation_version(uuid,uuid,uuid)'::regprocedure) as approve_fixed_path
    `,
    expected: {
      ledger: 1,
      rls: true,
      policies: 1,
      indexes: 2,
      app_select: true,
      app_insert: false,
      app_update: false,
      app_delete: false,
      create_app_exec: true,
      create_public_exec: false,
      approve_app_exec: true,
      approve_public_exec: false,
      create_fixed_path: true,
      approve_fixed_path: true,
    },
  },
  "0039_approved_sql_publications.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations where filename = $1) as ledger,
        (select relrowsecurity from pg_class where oid = 'public.pipeline_sql_publications'::regclass) as rls,
        (select count(*)::integer from pg_policies
          where schemaname = 'public' and tablename = 'pipeline_sql_publications') as policies,
        (select count(*)::integer from pg_indexes
          where schemaname = 'public' and tablename = 'pipeline_sql_publications'
            and indexname in ('pipeline_sql_publications_tenant_idx', 'pipeline_sql_publications_due_idx')) as indexes,
        has_function_privilege('app_user', 'public.validate_pipeline_sql_publication()', 'execute') as validate_app_exec,
        has_function_privilege('public', 'public.validate_pipeline_sql_publication()', 'execute') as validate_public_exec,
        has_function_privilege('app_user', 'public.claim_due_sql_publication_syncs(integer)', 'execute') as claim_app_exec,
        has_function_privilege('public', 'public.claim_due_sql_publication_syncs(integer)', 'execute') as claim_public_exec,
        (select count(*)::integer from pg_proc
          where oid in (
            'public.protect_pipeline_sql_publication_identity()'::regprocedure,
            'public.protect_approved_sql_publication_pipeline()'::regprocedure,
            'public.protect_approved_sql_publication_mappings()'::regprocedure
          ) and has_function_privilege('app_user', oid, 'execute')) as protection_app_exec,
        (select count(*)::integer from pg_proc
          where oid in (
            'public.protect_pipeline_sql_publication_identity()'::regprocedure,
            'public.protect_approved_sql_publication_pipeline()'::regprocedure,
            'public.protect_approved_sql_publication_mappings()'::regprocedure
          ) and has_function_privilege('public', oid, 'execute')) as protection_public_exec,
        (select count(*)::integer from pg_proc
          where oid in (
            'public.protect_pipeline_sql_publication_identity()'::regprocedure,
            'public.protect_approved_sql_publication_pipeline()'::regprocedure,
            'public.protect_approved_sql_publication_mappings()'::regprocedure
          ) and coalesce(proconfig, array[]::text[]) @> array['search_path=""']) as protection_fixed_paths,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""'] from pg_proc
          where oid = 'public.validate_pipeline_sql_publication()'::regprocedure) as validate_fixed_path,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""'] from pg_proc
          where oid = 'public.claim_due_sql_publication_syncs(integer)'::regprocedure) as claim_fixed_path
    `,
    expected: {
      ledger: 1,
      rls: true,
      policies: 3,
      indexes: 2,
      validate_app_exec: true,
      validate_public_exec: false,
      claim_app_exec: true,
      claim_public_exec: false,
      protection_app_exec: 3,
      protection_public_exec: 0,
      protection_fixed_paths: 3,
      validate_fixed_path: true,
      claim_fixed_path: true,
    },
  },
  "0040_sql_analysis_and_certified_metrics.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations where filename = $1) as ledger,
        (select count(*)::integer from pg_class where oid in (
          'public.sql_analysis_queries'::regclass,
          'public.sql_analysis_rows'::regclass,
          'public.analytics_widget_query_sources'::regclass,
          'public.sql_analysis_certifications'::regclass
        ) and relrowsecurity) as rls_tables,
        (select count(*)::integer from pg_policies where schemaname = 'public'
          and tablename in ('sql_analysis_queries', 'sql_analysis_rows',
                            'analytics_widget_query_sources', 'sql_analysis_certifications')) as policies,
        (select count(*)::integer from pg_indexes where schemaname = 'public'
          and indexname in ('sql_analysis_queries_tenant_status_idx',
                            'sql_analysis_queries_connector_idx',
                            'sql_analysis_rows_query_period_idx',
                            'sql_analysis_rows_scope_idx',
                            'analytics_widget_query_sources_query_idx',
                            'sql_analysis_certifications_query_idx',
                            'sql_analysis_certifications_kpi_idx')) as indexes,
        has_function_privilege('app_user', 'public.can_read_sql_analysis_row(uuid,uuid,uuid)', 'execute') as app_exec,
        has_function_privilege('public', 'public.can_read_sql_analysis_row(uuid,uuid,uuid)', 'execute') as public_exec,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""'] from pg_proc
          where oid = 'public.can_read_sql_analysis_row(uuid,uuid,uuid)'::regprocedure) as fixed_path
    `,
    expected: {
      ledger: 1,
      rls_tables: 4,
      policies: 10,
      indexes: 7,
      app_exec: true,
      public_exec: false,
      fixed_path: true,
    },
  },
  "0041_canvas_creator_capability.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations where filename = $1) as ledger,
        (select count(*)::integer from information_schema.columns
          where table_schema = 'public' and table_name = 'tenant_memberships'
            and column_name = 'canvas_role' and is_nullable = 'NO') as canvas_column,
        (select count(*)::integer from pg_indexes where schemaname = 'public'
          and indexname = 'tenant_memberships_canvas_creator_idx') as creator_index,
        has_function_privilege('app_user', 'public.can_create_canvas(uuid)', 'execute') as app_exec,
        has_function_privilege('public', 'public.can_create_canvas(uuid)', 'execute') as public_exec,
        (select coalesce(proconfig, array[]::text[]) @> array['search_path=""'] from pg_proc
          where oid = 'public.can_create_canvas(uuid)'::regprocedure) as fixed_path,
        (select count(*)::integer from pg_policies where schemaname = 'public'
          and tablename = 'analytics_views' and policyname = 'analytics views: selected tenant inserts') as insert_policy
    `,
    expected: {
      ledger: 1,
      canvas_column: 1,
      creator_index: 1,
      app_exec: true,
      public_exec: false,
      fixed_path: true,
      insert_policy: 1,
    },
  },
  "0042_sql_analysis_collaboration_policy.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations where filename = $1) as ledger,
        (select count(*)::integer from pg_policies where schemaname = 'public'
          and tablename = 'sql_analysis_queries') as query_policies,
        (select count(*)::integer from pg_policies where schemaname = 'public'
          and tablename = 'sql_analysis_queries'
          and policyname in ('SQL analyses: selected tenant governor reads',
                             'SQL analyses: selected tenant governor inserts',
                             'SQL analyses: selected tenant governor updates',
                             'SQL analyses: selected tenant governor deletes')) as named_policies,
        has_table_privilege('app_user', 'public.sql_analysis_queries', 'select') as app_select,
        has_table_privilege('app_user', 'public.sql_analysis_queries', 'insert') as app_insert,
        has_table_privilege('app_user', 'public.sql_analysis_queries', 'update') as app_update,
        has_table_privilege('app_user', 'public.sql_analysis_queries', 'delete') as app_delete
    `,
    expected: {
      ledger: 1,
      query_policies: 4,
      named_policies: 4,
      app_select: true,
      app_insert: true,
      app_update: true,
      app_delete: true,
    },
  },
  "0043_outbound_sql_gateway.sql": {
    query: `
      select
        (select count(*)::integer from public._migrations where filename = $1) as ledger,
        (select count(*)::integer from pg_class where oid in (
          'public.connector_gateways'::regclass,
          'public.connector_gateway_jobs'::regclass
        ) and relrowsecurity) as rls_tables,
        (select count(*)::integer from pg_policies where schemaname = 'public'
          and tablename in ('connector_gateways', 'connector_gateway_jobs')) as policies,
        (select count(*)::integer from pg_indexes where schemaname = 'public'
          and indexname in (
            'connector_gateways_active_name_idx',
            'connector_gateways_tenant_status_idx',
            'connector_gateways_device_idx',
            'connector_gateway_jobs_one_active_query_idx',
            'connector_gateway_jobs_claim_idx',
            'connector_gateway_jobs_tenant_query_idx'
          )) as indexes,
        has_table_privilege('app_user', 'public.connector_gateways', 'select') as gateway_table_select,
        has_column_privilege('app_user', 'public.connector_gateways', 'id', 'select') as gateway_safe_select,
        has_column_privilege('app_user', 'public.connector_gateways', 'enrollment_token_hash', 'select') as enrollment_hash_select,
        has_column_privilege('app_user', 'public.connector_gateways', 'device_token_hash', 'select') as device_hash_select,
        has_table_privilege('app_user', 'public.connector_gateways', 'insert') as gateway_insert,
        has_table_privilege('app_user', 'public.connector_gateways', 'update') as gateway_update,
        has_table_privilege('app_user', 'public.connector_gateway_jobs', 'select') as job_table_select,
        has_column_privilege('app_user', 'public.connector_gateway_jobs', 'id', 'select') as job_safe_select,
        has_column_privilege('app_user', 'public.connector_gateway_jobs', 'lease_token_hash', 'select') as lease_hash_select,
        has_table_privilege('app_user', 'public.connector_gateway_jobs', 'insert') as job_insert,
        has_table_privilege('app_user', 'public.connector_gateway_jobs', 'update') as job_update,
        (select count(*)::integer from pg_proc where oid in (
          'public.create_connector_gateway_enrollment(uuid,text,text,text,timestamptz,uuid)'::regprocedure,
          'public.begin_connector_gateway_enrollment(text)'::regprocedure,
          'public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb)'::regprocedure,
          'public.fail_connector_gateway_enrollment(uuid,text,text)'::regprocedure,
          'public.revoke_connector_gateway(uuid,uuid,uuid)'::regprocedure,
          'public.enqueue_connector_gateway_sql_analysis(uuid,uuid,uuid)'::regprocedure,
          'public.claim_connector_gateway_job(text,text)'::regprocedure,
          'public.authenticate_connector_gateway_device(text)'::regprocedure,
          'public.authenticate_connector_gateway_job_result(text,uuid,text)'::regprocedure,
          'public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid)'::regprocedure
        ) and has_function_privilege('app_user', oid, 'execute')) as app_exec,
        (select count(*)::integer from pg_proc where oid in (
          'public.create_connector_gateway_enrollment(uuid,text,text,text,timestamptz,uuid)'::regprocedure,
          'public.begin_connector_gateway_enrollment(text)'::regprocedure,
          'public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb)'::regprocedure,
          'public.fail_connector_gateway_enrollment(uuid,text,text)'::regprocedure,
          'public.revoke_connector_gateway(uuid,uuid,uuid)'::regprocedure,
          'public.enqueue_connector_gateway_sql_analysis(uuid,uuid,uuid)'::regprocedure,
          'public.claim_connector_gateway_job(text,text)'::regprocedure,
          'public.authenticate_connector_gateway_device(text)'::regprocedure,
          'public.authenticate_connector_gateway_job_result(text,uuid,text)'::regprocedure,
          'public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid)'::regprocedure
        ) and has_function_privilege('public', oid, 'execute')) as public_exec,
        (select count(*)::integer from pg_proc where oid in (
          'public.create_connector_gateway_enrollment(uuid,text,text,text,timestamptz,uuid)'::regprocedure,
          'public.begin_connector_gateway_enrollment(text)'::regprocedure,
          'public.complete_connector_gateway_enrollment(uuid,text,text,uuid,uuid,text,text,text,integer,jsonb)'::regprocedure,
          'public.fail_connector_gateway_enrollment(uuid,text,text)'::regprocedure,
          'public.revoke_connector_gateway(uuid,uuid,uuid)'::regprocedure,
          'public.enqueue_connector_gateway_sql_analysis(uuid,uuid,uuid)'::regprocedure,
          'public.claim_connector_gateway_job(text,text)'::regprocedure,
          'public.authenticate_connector_gateway_device(text)'::regprocedure,
          'public.authenticate_connector_gateway_job_result(text,uuid,text)'::regprocedure,
          'public.finish_connector_gateway_job(uuid,uuid,text,text,text,integer,text,uuid)'::regprocedure
        ) and coalesce(proconfig, array[]::text[]) @> array['search_path=""']) as fixed_paths,
        (select count(*)::integer from pg_constraint
          where conrelid = 'public.sql_analysis_queries'::regclass
            and conname = 'sql_analysis_queries_last_run_status_check'
            and pg_get_constraintdef(oid) like '%queued%') as queued_status
    `,
    expected: {
      ledger: 1,
      rls_tables: 2,
      policies: 2,
      indexes: 6,
      gateway_table_select: false,
      gateway_safe_select: true,
      enrollment_hash_select: false,
      device_hash_select: false,
      gateway_insert: false,
      gateway_update: false,
      job_table_select: false,
      job_safe_select: true,
      lease_hash_select: false,
      job_insert: false,
      job_update: false,
      app_exec: 10,
      public_exec: 0,
      fixed_paths: 10,
      queued_status: 1,
    },
  },
};

// 0044 closes inherited default table grants discovered by the 0043 verifier;
// all other gateway invariants must remain unchanged.
verifiers["0044_gateway_least_privilege_correction.sql"] = verifiers["0043_outbound_sql_gateway.sql"];
verifiers["0045_gateway_completion_authority_hardening.sql"] = verifiers["0043_outbound_sql_gateway.sql"];
verifiers["0046_gateway_device_authentication.sql"] = verifiers["0043_outbound_sql_gateway.sql"];
verifiers["0047_gateway_token_column_privacy.sql"] = verifiers["0043_outbound_sql_gateway.sql"];

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
