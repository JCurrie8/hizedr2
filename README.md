# Hized Platform

The multi-tenant Hized product (Connect · Pulse · Canvas · Advisory) — separate from the [hized-web](https://github.com/JCurrie8/Hized) marketing site.

Currently in **Phase 0** (tenancy, auth, organisation hierarchy, environments, CI/CD). See:

- [`docs/product/blueprint.md`](docs/product/blueprint.md) — the full product blueprint (v1.1)
- [`docs/architecture`](docs/architecture) — schema, RLS design and diagrams as they land

## Stack

Next.js (App Router, TypeScript) + Neon (Postgres) + Better Auth + Cloudflare R2 (storage) + Resend (email) + Vercel, in a pnpm/Turborepo monorepo. Tenant isolation is enforced by Postgres RLS via a session variable (`app.current_user_id`), not a vendor-specific JWT helper.

## Development

```bash
pnpm install
pnpm --filter @hized/web dev
```

## Structure

```
/apps/web            Next.js application
/packages/ui          design tokens (Hized brand palette/type) + Tailwind theme
/packages/contracts    shared TS/zod types across app and future worker
/packages/testing      Neon test-database client factory, fixtures, RLS test harness
/db                    Postgres migrations and seed data (plain SQL)
/docs                  architecture notes, runbooks, product docs
```
