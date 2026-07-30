import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { Pool } from "@neondatabase/serverless";

/**
 * Better Auth owns its own tables (user, session, account, verification,
 * twoFactor) — created via `npx @better-auth/cli generate`, not our own
 * /db migrations. Those tables are NOT covered by our RLS scheme: Better
 * Auth is the trusted boundary for them, the same way Supabase's auth.users
 * schema would have been. Our own public.profiles table (RLS-protected)
 * has no typed FK to "user" — see db/migrations/0002_core_schema.sql for
 * why (Better Auth's id column is text, not uuid) — it maps via
 * profiles.auth_user_id instead.
 *
 * generateId is overridden to emit uuid-formatted strings for consistency
 * with the rest of the schema's values, even though the column itself
 * stays `text` regardless.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const auth = betterAuth({
  database: pool,
  // Every tenant is a different subdomain/origin by design (see the
  // Phase 0 plan's tenant-resolution section) — Better Auth's default
  // origin check only trusts a single baseURL, so it rejects every
  // tenant subdomain's requests without this.
  trustedOrigins: ["*.localhost:3001", "*.hized.com", "localhost:3001", "hized.com"],
  emailAndPassword: {
    enabled: true,
  },
  // nextCookies() must stay last — it patches Server Action cookie
  // handling and Better Auth applies plugin hooks in registration order.
  plugins: [twoFactor(), nextCookies()],
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
    // A session must work across tenant subdomains (a Hized consultant
    // moving between two client tenants, or just this user checking a
    // tenant they're not a member of) — per-tenant ACCESS is enforced by
    // getAuthContext()'s membership check, not by cookie scope. Without
    // this, the cookie is siloed per-subdomain and every cross-subdomain
    // request just looks unauthenticated instead of correctly "forbidden".
    //
    // Deliberately NOT enabled for a bare "localhost" domain: Chromium
    // rejects/won't persist a cookie with Domain=.localhost at all
    // (treats it like a public suffix — confirmed by testing, it broke
    // login even on a single subdomain, not just cross-subdomain
    // sharing). Real registrable domains (.hized.com in staging/prod)
    // don't have this problem, so this only degrades local dev, where
    // per-subdomain sessions are a UX inconvenience, not a security gap —
    // getAuthContext's membership check is still what actually enforces
    // tenant isolation either way.
    crossSubDomainCookies: {
      enabled: Boolean(process.env.COOKIE_DOMAIN) && !process.env.COOKIE_DOMAIN?.endsWith("localhost"),
      domain: process.env.COOKIE_DOMAIN,
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Provisioning is invite-only (blueprint 9.1) — no invitation,
        // no account. Runs through a SECURITY DEFINER function (see
        // 0004_invite_provisioning.sql) because at this point there is
        // no tenant_membership yet, so the normal RLS-gated path would
        // see nothing and reject every signup, invited or not.
        before: async (user) => {
          const { rows } = await pool.query("select public.has_pending_invitation($1) as ok", [user.email]);
          if (!rows[0]?.ok) {
            throw new APIError("BAD_REQUEST", {
              message: "This email has no pending invitation. Ask your admin to invite you first.",
            });
          }
        },
        // Creates the profiles row + activates the tenant_membership from
        // the matching invitation, atomically, via the same SECURITY
        // DEFINER function — see 0004_invite_provisioning.sql. This is
        // deliberately the ONLY path that can create a public.profiles
        // row; there is no other INSERT policy on that table.
        after: async (user) => {
          await pool.query("select public.accept_invitation_by_email($1, $2)", [user.id, user.email]);
        },
      },
    },
  },
});
