# Demo tenants and EPIC-01 walkthrough

The Phase 0 demo seed creates two stable, synthetic tenants and enough organisation structure to prove tenancy, routing, design-system shell, and hierarchy isolation. It intentionally does not invent jobs, pipeline runs, KPI definitions, dashboards, or Canvas records before those schemas exist.

## Safety model

- Seeding uses `MIGRATIONS_DATABASE_URL` because it is controlled setup data. The runtime `app_user` URL is deliberately rejected.
- Always name the target with `--target development`, `preview`, or `production`.
- Production additionally requires `--confirm-production`.
- `--rollback` runs the complete database write path inside a transaction and then discards it; use it to validate a target before the real seed.
- Re-running the same seed is idempotent while the seeded hierarchy is untouched. If an operator has edited or deactivated a seeded node, the seed fails rather than rewriting effective-dated history.
- The generated seed administrators have no password or session and cannot sign in. Pass a real `--admin-email` to create single-use, token-bound administrator invitations through the normal signup flow.
- Integration tests must not use the production database. Provision separate development and CI Neon branches before running database-mutating suites again.

## Commands

Preview the manifest without connecting to a database:

```powershell
pnpm --filter @hized/migrations seed-demo:dry-run
```

Seed a non-production environment:

```powershell
pnpm --filter @hized/migrations seed-demo -- --target development
```

Verify the persisted rows through the restricted runtime role and the shared `withUserContext` wrapper:

```powershell
pnpm --filter @hized/migrations verify-demo
```

Seed production deliberately and create administrator invitations:

```powershell
pnpm --filter @hized/migrations seed-demo -- --target production --confirm-production --admin-email you@example.com --base-url https://hized-platform.vercel.app
```

Only invitation hashes are persisted. Copy each displayed link when it is created. If a valid pending invitation already exists, the script will not replace it; use `--rotate-invites` explicitly to revoke pending links and issue new ones.

## Seed contents

- `northstar-installations`: an installation and service business with company, regional, site, team, employee, sales, customer-service, and finance nodes.
- `harbour-field-services`: a smaller second business with its own company-to-employee path, used as the cross-tenant control.

Both tenants carry `feature_flags.demoSeed = "phase0-v1"`, use deterministic IDs, and receive a `demo.seeded` audit event on each successful seed run.

## EPIC-01 walkthrough

1. Run the manifest test and quality checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
2. Seed the selected non-production database and accept both admin invitations with the same account to exercise the supported multi-tenant identity case.
3. On each tenant host, confirm the tenant shell resolves the correct slug and the organisation page shows only that tenant's hierarchy.
4. Confirm Northstar shows its complete company-to-employee drill path and never shows Harbour nodes; repeat in reverse for Harbour.
5. Confirm the tenant audit page includes `demo.seeded` and invitation/account activity only for the selected tenant.
6. Confirm the platform-admin tenant list can see both tenants and that the cross-tenant view writes its independent platform audit event.
7. Capture the Vercel production deployment commit and successful runtime/error scan in `PROGRESS.md`.

The full synthetic story in blueprint section 12.3 grows with later epics: Connect adds jobs and pipeline warnings, Pulse adds sales/service/finance KPIs and stale/target variance, and Canvas adds the promoted board. Phase 0 is complete when the two tenant shells and their data are demonstrably isolated; it does not require placeholder tables for future domains.
