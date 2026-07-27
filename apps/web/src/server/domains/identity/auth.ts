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
