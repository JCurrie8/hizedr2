import { Pool, type PoolClient } from "@neondatabase/serverless";

let pool: Pool | undefined;

/**
 * The app's restricted `app_user` connection (see db/setup-app-role.mjs).
 * Never the `neondb_owner`/MIGRATIONS_DATABASE_URL connection — that role
 * has BYPASSRLS=true and would silently defeat every RLS policy.
 */
function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString });
  }
  return pool;
}

/**
 * Runs `fn` inside a transaction with `app.current_user_id` set via
 * set_config(..., true) (transaction-local), which the RLS policies in
 * db/migrations/0003_rls.sql read via current_user_id(). Every
 * authenticated DB access in the app must go through this — a query run
 * outside it sees no session variable, and current_user_id() returns
 * null, which every policy resolves to "no access" (fails closed).
 *
 * Pass `userId: null` deliberately for genuinely unauthenticated access
 * (there is none in Phase 0 — everything is behind auth) or to prove the
 * fail-closed case in tests.
 */
export async function withUserContext<T>(
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    if (userId) {
      await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
