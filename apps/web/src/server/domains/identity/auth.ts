import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { Pool } from "@neondatabase/serverless";

/**
 * Better Auth owns its own tables (user, session, account, verification,
 * twoFactor) — created via `npx @better-auth/cli generate`, not our own
 * /db migrations. Those tables are NOT covered by our RLS scheme: Better
 * Auth is the trusted boundary for them, the same way Supabase's auth.users
 * schema would have been. Our own public.profiles table (RLS-protected)
 * references "user"(id) as a foreign key but is a separate set of rows we
 * manage ourselves.
 *
 * generateId is overridden to emit uuids so "user".id matches the uuid
 * type used everywhere else in the schema (Better Auth defaults to a
 * shorter text id).
 */
export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [twoFactor()],
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
});
