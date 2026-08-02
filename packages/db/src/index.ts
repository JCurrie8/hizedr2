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

export interface UserContext {
  /** The caller's public.profiles.id — null only for proving the fail-closed case in tests. */
  userId: string | null;
  /**
   * The tenant this specific request is scoped to. Required for any query
   * touching a tenant-isolated table (see db/migrations/0003_rls.sql,
   * 0005_explicit_tenant_context.sql) — current_tenant_id() reads this
   * exact value, it does NOT derive "the" tenant from the user's
   * memberships, because a user (e.g. Hized consultancy staff) can belong
   * to more than one tenant. Omit only for genuinely tenant-agnostic
   * queries (e.g. "which tenants am I a member of").
   */
  tenantId?: string | null;
}

/**
 * Runs `fn` inside a transaction with `app.current_user_id` and (if given)
 * `app.current_tenant_id` set via set_config(..., true) — transaction-
 * local, read by the RLS policies via current_user_id()/current_tenant_id().
 * Every authenticated DB access in the app must go through this — a query
 * run outside it, or with tenantId omitted, sees no tenant context, and
 * every tenant-scoped policy resolves to "no access" (fails closed).
 *
 * The caller (getAuthContext(), see apps/web/src/server/domains/access-control)
 * is responsible for having already validated that userId actually has an
 * active membership in tenantId — this function trusts whatever it's given.
 */
export async function withUserContext<T>(
  ctx: UserContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!ctx.userId && ctx.tenantId) {
    throw new Error("A tenant context requires an authenticated user");
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    if (ctx.userId) {
      await client.query("select set_config('app.current_user_id', $1, true)", [ctx.userId]);
    }
    if (ctx.tenantId) {
      await client.query("select set_config('app.current_tenant_id', $1, true)", [ctx.tenantId]);
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
