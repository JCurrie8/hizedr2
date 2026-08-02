# CI/CD runbook

Hized uses GitHub Actions for required verification and the existing Vercel Git integration for deployment. Pull requests run lint, typechecking, a production build, all migrations, and the database integration suites. A merge to `main` is then deployed by Vercel.

## Provisioned state (2026-08-02)

- Neon branch `ci` is the persistent, disposable database used only by GitHub Actions.
- `CI_MIGRATIONS_DATABASE_URL`, `CI_DATABASE_URL`, and `CI_DATABASE_SAFE_TO_MUTATE=true` are configured in the GitHub repository.
- Protected-main enforcement is still pending; do not describe the workflow as a required merge gate until both checks are required in repository settings.

## One-time repository configuration

1. Create a dedicated Neon branch/database for CI. It must not be development, staging, or production.
2. Run `pnpm --filter @hized/migrations migrate` against that branch as its owner, then run `pnpm --filter @hized/migrations setup-app-role` once to create the restricted runtime role.
3. Add these GitHub Actions repository secrets:
   - `CI_MIGRATIONS_DATABASE_URL`: owner connection used only for migrations and fixture administration.
   - `CI_DATABASE_URL`: the generated `app_user` connection used by application and RLS tests.
4. Add the repository variable `CI_DATABASE_SAFE_TO_MUTATE=true`. This is an explicit guard: do not set it until both URLs point to the dedicated CI database.
5. Protect `main`: require pull requests and the two CI checks, and disallow direct pushes. This ensures the exact commit has passed CI before Vercel's Git integration deploys it to production.

Never put either database URL or a Vercel token in the repository. Vercel already owns the application deployment and runtime environment variables, so this workflow intentionally does not duplicate deployment with a long-lived CLI token.

## Normal operation

- A pull request runs `Quality and production build`, then serializes `Migrations and database integration tests` against the shared CI database.
- Migration files are applied in filename order and are never rewritten after being applied.
- Vercel may create preview deployments for branches independently. Only a protected merge to `main` is a production release.
- If a database test fails, inspect the failing fixture first. Tests use unique IDs and clean up their records; the CI branch remains intentionally disposable and may be reset if it accumulates bad state.

## Schema release ordering

The CI database proves that the cumulative migrations and new application code work together; it does not mutate staging or production. Until a gated production-release workflow is configured, an operator must apply new migrations to staging, verify the deployment there, and apply them to production immediately before merging the corresponding application change to protected `main`.

Migration `0013_security_hardening.sql` intentionally removes the insecure email-only invitation functions. Apply it before deploying its application code: the old application will temporarily fail closed for new signups after the migration, while deploying the new application first would call functions that do not exist yet. Coordinate that brief signup maintenance window rather than allowing either mismatch to persist.

## Failure safety

The database job fails closed when either connection secret or the explicit safety variable is absent. If a URL is changed, re-check the Neon branch before re-enabling `CI_DATABASE_SAFE_TO_MUTATE`; the migration connection has schema-owner privileges and can make irreversible changes to the selected database.
