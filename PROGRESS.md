# Hized Platform — Progress Log

Shared status file for AI coding agents (Claude Code, Codex, etc.) working on this repo.

## How to use this file

- **Before starting work**, read "Current State" below to understand what exists, what's in progress, and what's already been decided — especially the RLS notes, which record real bugs already found and fixed.
- **After your session**, add a new dated entry under "Session Log" (newest at top) summarizing what you did, which files/migrations changed, and what's next. A few sentences, not a full diff — the git history has the diff.
- **Update "Current State"** if your session changed the overall picture (a task completed, a new architecture decision, a new gap found).
- **Don't silently remove or reverse another agent's entry or decision.** If you disagree, add a note explaining why rather than overwriting it — the next agent (or the human) needs to see both sides.
- If you're about to touch Row-Level Security policies, read the "RLS notes" section below first — several real cross-tenant data leaks were found and fixed here already, and the same bug shape is easy to reintroduce in a new table if the pattern isn't followed.

## Current State

**This repo** (`hized-platform`) is the actual multi-tenant Hized product. It is separate from `hized-web` (the marketing site, github.com/JCurrie8/Hized, deployed to hized.com) — do not confuse the two or edit one expecting it to affect the other.

**Stack**: Next.js (App Router, TypeScript) + Neon (Postgres) + Better Auth (self-hosted, no bundled vendor) + Cloudflare R2 (object storage, not yet used by any feature) + Vercel. pnpm + Turborepo monorepo.

**Product spec**: [`docs/product/blueprint.md`](docs/product/blueprint.md) (v1.5) is the source of truth for scope and requirements — read it before assuming what a feature should do. It includes a Platform Administration section (7) and MVP delivery phases (11.4).

**Deployment**:
- Marketing site → Vercel project `hized` → `hized.com` / `www.hized.com` (live, working, has real email forwarding via MX/TXT records at the registrar — do not touch this domain's DNS carelessly).
- This platform app → Vercel project `hized-platform`, git-linked to this repo, production at `https://hized-platform.vercel.app`. Production runtime has the restricted Neon `DATABASE_URL`, `BETTER_AUTH_SECRET`, and canonical `BETTER_AUTH_URL`; `MIGRATIONS_DATABASE_URL` is intentionally not in Vercel. Wildcard domain `*.hized.com` has been added in Vercel but the nameserver switch at the registrar has **not** happened yet — deliberately paused because it requires recreating the marketing site's MX/SPF records inside Vercel's DNS first, or email forwarding breaks. See git history / ask the user for current status before assuming it's done.

**Phase 0 (product foundation) progress** — blueprint section 11.4, this repo's own build sequence:

- [x] Repo scaffold, Hized design tokens ported into Tailwind
- [x] Neon + Better Auth + R2 provisioned
- [x] Core schema & migrations (`db/migrations/`, 14 migrations applied to the current production Neon branch as of 2026-08-02)
- [x] RLS policies + helper functions (`packages/testing/src/rls.test.ts`)
- [x] Auth integration — invitation signup/acceptance is bound to the single-use token and invited account email, including an existing user joining another tenant; MFA (TOTP) plugin wired server-side but **not yet enforced or given an enrollment UI**
- [x] Tenant resolution & app shell — subdomain middleware (`apps/web/src/proxy.ts` — Next.js 16 renamed `middleware.ts`; must live under `src/` given this project uses `--src-dir`), authenticated organisation landing/selection, a membership-validated Vercel/localhost path fallback, and login/invite/platform-admin pages
- [x] Org hierarchy CRUD + drill-down (half-open history, acyclic immediate edits, move cascades ltree paths to descendants, tested; scheduled/backdated mutation is deliberately not exposed yet)
- [x] Audit logging — writer + both viewer UIs (`/admin/audit`, `/platform-admin/audit`) built; privileged mutations and their events commit atomically, and cross-tenant platform reads are audited before returning
- [x] CI/CD merge gate — the workflow uses a dedicated Neon `ci` branch with separate owner/runtime secrets and a mutation guard. Protected `main` requires both hosted checks, an up-to-date branch, resolved conversations, and applies the rules to administrators. PR #1 passed and deployed to Vercel production. A gated staging/production schema-release path remains deliberately operator-driven per `docs/runbooks/ci-cd.md`.
- [~] Demo tenant seeding & EPIC-01 walkthrough — guarded/idempotent seed tooling and two production demo hierarchies exist; restricted-role verification proves 12/6 own nodes and zero cross-tenant nodes. The Northstar signup succeeded and the Harbour invitation exists; releasing the corrected organisation landing route and then verifying both authenticated tenant views remain.
- [~] Security hardening & Phase 0 exit review — the 2026-08-02 review findings are fixed and covered by integration tests; the broader exit review remains

**Known gaps / deliberately deferred (not oversights — don't "fix" without checking why first)**:
- MFA enrollment UI + enforcement — plugin exists, nothing requires it yet.
- No Playwright/e2e automation — verification so far has been real vitest integration tests against the live Neon database, plus manual browser checks. Adding proper e2e is welcome but hasn't been prioritized yet.
- Resend/email is skipped entirely — invite links are shown/copied in the admin UI (`/admin/users`), never emailed. This was an explicit user decision to avoid a paid dependency pre-revenue.
- Blueprint section 7.5: PLATFORM-005 (cross-tenant health aggregation) and PLATFORM-006 ("view as" impersonation) are explicitly out of scope for MVP.
- CI is an active required merge gate backed by its own persistent Neon `ci` branch. The CI database is intentionally disposable, while staging/production schema releases remain operator-gated; follow `docs/runbooks/ci-cd.md` before introducing a migration.
- Local owner/runtime URLs now point to the separate Neon `vercel-dev` branch, which has migrations 0001–0014 and its own restricted `app_user`. The production branch is no longer the default target for local integration tests.

**RLS notes — read before adding or changing a policy**:
- Tenant isolation is Postgres RLS, not Supabase's `auth.uid()` (this project isn't on Supabase — see blueprint's "Resolved since v1.1" note). Session context is two Postgres session variables (`app.current_user_id`, `app.current_tenant_id`) set per-transaction by `packages/db`'s `withUserContext()` — every authenticated query must go through it, or RLS sees no context and fails closed (visible as "nothing", not an error).
- The app connects as a restricted `app_user` Postgres role (`db/setup-app-role.mjs`), never as `neondb_owner` — that role has `BYPASSRLS=true` and would silently defeat every policy. Migrations use `MIGRATIONS_DATABASE_URL` (owner); the running app uses `DATABASE_URL` (`app_user`).
- **Three real cross-tenant leaks were found and fixed by testing, not by inspection** — the same bug shape is easy to reintroduce in a new table:
  - `db/migrations/0006`: `*_company_admin write` policies (`for all`, so also applied to `SELECT`) checked `is_company_admin(tenant_id)` against the *row's own* tenant, independent of session context — a company_admin of more than one tenant (e.g. Hized consultancy staff, supported by design) could read/write every tenant they administer at once, regardless of which tenant the session was scoped to. Fix: every such policy also requires `tenant_id = current_tenant_id()`.
  - `db/migrations/0007`: the `tenants` table's own SELECT policy queried `tenant_memberships` directly in a subquery — but RLS policies (unlike `SECURITY DEFINER` functions) run with the caller's own privileges, so that nested read was itself blocked by `tenant_memberships`' RLS when no tenant context was set yet (the literal "which tenants am I in" case). Fixed with a dedicated `SECURITY DEFINER` function, `current_user_tenant_ids()`.
  - `db/migrations/0011`: `audit_log`'s SELECT policy had the exact same shape as 0006, found by inspection before building the audit viewer UI on top of it — worth checking for this pattern in any table you add a "company_admin can manage their own tenant's X" policy to.
- Rule of thumb for a new tenant-scoped table's admin-write policy: `tenant_id = current_tenant_id() and (is_company_admin(tenant_id) or is_platform_admin())` — not just the role check alone.
- Migration `0013` hardens the surrounding database trust boundary: tenant context without a user is rejected in `withUserContext`, audit actors are session-bound, profile security columns are not runtime-updatable, invitation authority is token-bound, and Hized `SECURITY DEFINER` helpers use fixed search paths with no `PUBLIC` execute grant. Preserve those function and column grants in future migrations.
- A fourth isolation weakness was found by the EPIC-01 production verifier: a genuine profile paired by trusted server code with a tenant it did not belong to could read that tenant's `tenant_memberships`, `org_nodes`, and `invitations`, because those SELECT policies trusted `current_tenant_id()` without independently checking active membership. No client-controlled path around `getAuthContext()` was found, but migration `0014` now binds those reads to `current_user_has_tenant_access()` so a future server context-pairing bug fails closed at RLS too.

## Session Log

### 2026-08-02 — Codex (protected production gate + EPIC-01 walkthrough)

Completed GitHub sudo approval, saved the rotated restricted CI database secret, and reran PR #1. All four checks passed, including `Quality and production build` and `Migrations and database integration tests`; PR #1 merged to protected `main` at `fb7bbfa`, Vercel reported the corresponding production deployment READY, and the live platform returned 200. Configured `main` to require pull requests, both CI checks, an up-to-date branch, resolved review conversations, and no administrator bypass.

Created real company-admin invitations for the user's account in both Northstar Installations and Harbour Field Services. Opened the Northstar acceptance page for the user to choose their own application password; after acceptance, the remaining EPIC-01 work is to verify both authenticated tenant views and role boundaries. Created `codex/connect-vertical-slice` from the released `main`; the next product build is the blueprint's connector → ETL run/validation → curated job → Pulse KPI thin vertical slice rather than another open-ended hardening pass.

The Northstar signup returned 200 in production, but its client redirect sent the authenticated user to `/dashboard` on the apex Vercel hostname, which cannot supply a tenant slug and therefore correctly rendered the app shell's `Access denied` state. Added an authenticated `/organisations` landing route, single/multi-membership resolution through the existing user-only RLS context, and an apex-only `/t/:slug/*` rewrite for Vercel/localhost; canonical `*.hized.com` links remain unchanged. Login and both invitation acceptance paths now enter through organisation resolution, and a missing tenant slug recovers there instead of presenting a misleading denial. Updated the blueprint to v1.5 with the organisation-selection and preview-routing requirement. Verification passes 40 tests (14 RLS, 23 web, 3 demo-manifest), typecheck, lint, production build, and `git diff --check`.

### 2026-08-02 — Codex (CI activation)

Provisioned a persistent Neon `ci` branch cloned from production, configured GitHub's `CI_MIGRATIONS_DATABASE_URL` / `CI_DATABASE_URL` secrets and `CI_DATABASE_SAFE_TO_MUTATE=true` guard, and confirmed the restricted runtime role sees each demo tenant's own hierarchy with zero cross-tenant rows. The first hosted database job correctly failed closed before configuration; after activation, its safety gate and cumulative migrations passed and exposed two test-path issues rather than a database isolation failure.

Added `MIGRATIONS_DATABASE_URL` to Turborepo's environment allowlist so GitHub-supplied owner credentials reach Vitest, and disambiguated the shared invitation fixture parameter's Postgres type. Verification against the isolated CI branch now passes all 35 tests (14 RLS, 18 web, 3 demo-manifest), plus lint, typecheck, production build, and `git diff --check`. Next: merge through a green pull request, require both checks on protected `main`, then finish real admin invitations and the interactive EPIC-01 walkthrough.

Also migrated the existing Neon `vercel-dev` branch through 0014, created its own restricted `app_user`, switched both ignored local environment files away from production, and reran all 35 tests successfully there. The CI role was rotated and its exact connection verified locally; updating GitHub's `CI_DATABASE_URL` is currently paused at GitHub's sudo confirmation because the mobile approval request timed out. PR #1 remains open and unmerged until that secret is saved and both hosted checks pass.

### 2026-08-02 — Codex (GPT-5 production release + EPIC-01 seed)

Released the security-hardening work to `main` and Vercel production after applying migration `0013`, rotating the Neon `app_user` password and Better Auth secret, and configuring production-only Vercel runtime variables. Commit `c975550` reached READY at `https://hized-platform.vercel.app`; its build had no missing-environment warning, the homepage and a short-lived real Neon invitation both returned 200, the probe tenant was deleted, and the deployment had no warning/error/fatal runtime logs.

Started the next task: added guarded, idempotent Phase 0 demo seeding, manifest tests, a restricted-role isolation verifier, and `docs/runbooks/demo-tenants.md`; seeded Northstar Installations and Harbour Field Services into production without any real-person login. The first verifier run uncovered a context/membership gap in three RLS SELECT policies. Added and applied migration `0014_bind_tenant_context_to_membership.sql` plus a regression test; the post-migration verifier now proves each seed principal sees exactly its own tenant and 12/6 own hierarchy nodes with zero cross-tenant rows. Updated the blueprint to v1.4 to make synthetic demo delivery progressive and to forbid development/CI mutation of the production Neon branch. Next: provision separate Neon development/CI branches and GitHub gates, then issue real admin invitations and complete the interactive EPIC-01 walkthrough.

### 2026-08-02 — Codex (GPT-5 implementation)

Implemented every actionable finding from the preceding review. Migration `0013_security_hardening.sql` was applied to development: invitations now require the stored token hash and resolve the Better Auth account email in the database, existing users can accept an invitation to another tenant, hierarchy scope ranges are consistently half-open, audit actors and profile-column privileges are constrained, and all Hized `SECURITY DEFINER` helpers have fixed search paths and explicit grants. `withUserContext` now rejects tenant-only context and the proxy strips untrusted incoming tenant headers.

Organisation moves now lock the affected tree, reject self/descendant parents, cascade paths with scope assertions, and permit only immediate interactive edits until scheduled/backdated reorganisation semantics are designed (initial imports can still establish history). Privileged mutations and reads now write audit events in the same transaction. Updated the product blueprint to v1.3 with these invariants, added the GitHub Actions CI workflow plus `docs/runbooks/ci-cd.md`, and retained Vercel Git integration as the sole deployment path. Verification passed: 31 integration tests (13 RLS + 18 web), typecheck, lint, production build, and `git diff --check`. CI activation still requires the dedicated Neon branch/secrets/guard variable, protected-main settings, and a gated staging/production migration-release path described in the runbook; next product task after that is demo tenant seeding and the EPIC-01 walkthrough.

### 2026-08-02 — Codex (GPT-5 review)

Security/correctness review only; no production code changed. Read the v1.2 blueprint and reviewed migrations 0003/0006/0007/0011, `withUserContext`, `getAuthContext`, org hierarchy operations/tests, proxy routing, and the relevant auth/audit call sites. The three recorded RLS fixes are sound in the final cumulative schema, the live runtime role is correctly non-superuser/non-`BYPASSRLS`, and the existing focused suites passed (8 RLS tests + 11 web tests; typecheck also passed).

Disagreements / follow-ups found: (1) invite acceptance is not bound to the secret token or verified email ownership — Better Auth signup accepts anyone who knows a pending invited email, and the existing auth test actually exercises signup with an arbitrary unused token hash; treat this as the highest-priority security issue. (2) `editOrgNode` permits moving a node under its own descendant and persists a parent cycle; a temporary live integration probe confirmed it. (3) `current_user_scope_paths()` treats `valid_to` as inclusive (`>=`) while the schema/list queries use an exclusive end, so a move effective today returns both old and new scope paths; also confirmed live. (4) `/platform-admin/audit` reads cross-tenant data without logging that view, contrary to PLATFORM-003/section 7.4, and privileged mutations generally commit in a separate transaction from their audit write, so an audit failure can leave an unaudited successful action. (5) `profiles: update self only` restricts rows but not columns, so the broad `app_user` UPDATE grant permits changing security-sensitive `auth_user_id` and `is_hized_staff` if a self-profile update path is added. (6) `withUserContext` accepts `tenantId` with a null/unvalidated `userId` (an invalid state that tenant-only SELECT policies would honor), `proxy.ts` preserves a client-supplied `x-tenant-slug` on non-tenant hosts, and the live `SECURITY DEFINER` helpers still grant EXECUTE to `PUBLIC`; none has a current HTTP exploit path found, but all weaken the intended trust boundary and should be hardened during the Phase 0 security pass.

### 2026-08-02 — Claude (Sonnet 5)

Created this file. Summarized all prior work above into "Current State" so a cold-started agent (or Codex) has the full picture, not just today's diff.

Completed task 8 (audit logging): writer wired into invite creation, org node create/deactivate, invitation acceptance (via the `accept_invitation_by_email` SQL function, since it runs before any session context exists), and platform-admin's tenant-list view (PLATFORM-003). Built both viewer UIs (`/admin/audit` tenant-scoped, `/platform-admin/audit` cross-tenant) and tenant provisioning (PLATFORM-001) and invite-creation UIs, neither of which existed before — invitations could previously only be created via raw SQL in tests, and tenants only via a scratch script.

Three more real bugs found by testing live rather than assumed away:
- `db/migrations/0011`: `audit_log`'s own SELECT policy had the same "company_admin of multiple tenants sees more than they should" leak as 0006 — caught by inspection before building the viewer, not after.
- `db/migrations/0012`: `profiles.full_name` was never populated from Better Auth's captured name, so the audit viewer showed "system" instead of the actual actor — caught by looking at the live viewer output, not by code review.
- `apps/web/src/proxy.ts`: the admin-subdomain rewrite only handled the exact root path ("/"), so `/platform-admin/audit` was unreachable via `admin.*/audit` — a 404 in the browser is what surfaced this. Fixed to a prefix-exclusion (skip `/login`, `/invite`, `/api`; rewrite everything else) instead of an exact-match inclusion.

All three fixes verified live end-to-end: invite → signup → org node create → tenant create, checked against both audit viewers, confirmed correct actor names and correct tenant scoping (including cross-tenant visibility for the platform-admin view specifically).

Also handled, unrelated to task 8: sent the user a marketing+platform setup overview PDF and confirmed the blueprint is current; DNS/wildcard-domain work for `*.hized.com` is paused (needs the marketing site's live email-forwarding MX/SPF records recreated in Vercel's DNS before switching nameservers — see the PDF or ask the user for current status, don't assume it's done).

Next: CI/CD pipeline (task 9).
