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

**Product spec**: [`docs/product/blueprint.md`](docs/product/blueprint.md) (v1.2) is the source of truth for scope and requirements — read it before assuming what a feature should do. It includes a Platform Administration section (7) and MVP delivery phases (11.4).

**Deployment**:
- Marketing site → Vercel project `hized` → `hized.com` / `www.hized.com` (live, working, has real email forwarding via MX/TXT records at the registrar — do not touch this domain's DNS carelessly).
- This platform app → Vercel project `hized-platform`, git-linked to this repo, deployed. Wildcard domain `*.hized.com` has been added in Vercel but the nameserver switch at the registrar has **not** happened yet — deliberately paused because it requires recreating the marketing site's MX/SPF records inside Vercel's DNS first, or email forwarding breaks. See git history / ask the user for current status before assuming it's done.

**Phase 0 (product foundation) progress** — blueprint section 11.4, this repo's own build sequence:

- [x] Repo scaffold, Hized design tokens ported into Tailwind
- [x] Neon + Better Auth + R2 provisioned
- [x] Core schema & migrations (`db/migrations/`, 11 migrations applied as of this entry)
- [x] RLS policies + helper functions (`packages/testing/src/rls.test.ts`)
- [x] Auth integration — invite-gated signup enforced at the DB level; MFA (TOTP) plugin wired server-side but **not yet enforced or given an enrollment UI**
- [x] Tenant resolution & app shell — subdomain middleware (`apps/web/src/proxy.ts` — Next.js 16 renamed `middleware.ts`; must live under `src/` given this project uses `--src-dir`), login/invite/platform-admin pages
- [x] Org hierarchy CRUD + drill-down (effective-dated edits, move cascades ltree paths to descendants, tested)
- [~] Audit logging — writer + both viewer UIs (`/admin/audit`, `/platform-admin/audit`) built; check git log for exactly which actions are wired up as of your session
- [ ] CI/CD pipeline
- [ ] Demo tenant seeding & EPIC-01 walkthrough
- [ ] Security hardening & Phase 0 exit review

**Known gaps / deliberately deferred (not oversights — don't "fix" without checking why first)**:
- MFA enrollment UI + enforcement — plugin exists, nothing requires it yet.
- No Playwright/e2e automation — verification so far has been real vitest integration tests against the live Neon database, plus manual browser checks. Adding proper e2e is welcome but hasn't been prioritized yet.
- Resend/email is skipped entirely — invite links are shown/copied in the admin UI (`/admin/users`), never emailed. This was an explicit user decision to avoid a paid dependency pre-revenue.
- Blueprint section 7.5: PLATFORM-005 (cross-tenant health aggregation) and PLATFORM-006 ("view as" impersonation) are explicitly out of scope for MVP.

**RLS notes — read before adding or changing a policy**:
- Tenant isolation is Postgres RLS, not Supabase's `auth.uid()` (this project isn't on Supabase — see blueprint's "Resolved since v1.1" note). Session context is two Postgres session variables (`app.current_user_id`, `app.current_tenant_id`) set per-transaction by `packages/db`'s `withUserContext()` — every authenticated query must go through it, or RLS sees no context and fails closed (visible as "nothing", not an error).
- The app connects as a restricted `app_user` Postgres role (`db/setup-app-role.mjs`), never as `neondb_owner` — that role has `BYPASSRLS=true` and would silently defeat every policy. Migrations use `MIGRATIONS_DATABASE_URL` (owner); the running app uses `DATABASE_URL` (`app_user`).
- **Three real cross-tenant leaks were found and fixed by testing, not by inspection** — the same bug shape is easy to reintroduce in a new table:
  - `db/migrations/0006`: `*_company_admin write` policies (`for all`, so also applied to `SELECT`) checked `is_company_admin(tenant_id)` against the *row's own* tenant, independent of session context — a company_admin of more than one tenant (e.g. Hized consultancy staff, supported by design) could read/write every tenant they administer at once, regardless of which tenant the session was scoped to. Fix: every such policy also requires `tenant_id = current_tenant_id()`.
  - `db/migrations/0007`: the `tenants` table's own SELECT policy queried `tenant_memberships` directly in a subquery — but RLS policies (unlike `SECURITY DEFINER` functions) run with the caller's own privileges, so that nested read was itself blocked by `tenant_memberships`' RLS when no tenant context was set yet (the literal "which tenants am I in" case). Fixed with a dedicated `SECURITY DEFINER` function, `current_user_tenant_ids()`.
  - `db/migrations/0011`: `audit_log`'s SELECT policy had the exact same shape as 0006, found by inspection before building the audit viewer UI on top of it — worth checking for this pattern in any table you add a "company_admin can manage their own tenant's X" policy to.
- Rule of thumb for a new tenant-scoped table's admin-write policy: `tenant_id = current_tenant_id() and (is_company_admin(tenant_id) or is_platform_admin())` — not just the role check alone.

## Session Log

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
