import { Pool } from "@neondatabase/serverless";
import type { AppRole } from "@hized/contracts";

/**
 * Admin-connection (neondb_owner / MIGRATIONS_DATABASE_URL) fixture
 * helpers — bypasses RLS deliberately, since fixture setup isn't what
 * we're testing. The RLS suite itself must use @hized/db's
 * withUserContext (the restricted app_user connection) for every
 * assertion query.
 */
export function getAdminPool(): Pool {
  const connectionString = process.env.MIGRATIONS_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is not set");
  return new Pool({ connectionString });
}

export interface TenantFixture {
  tenantId: string;
  profileId: string;
  authUserId: string;
}

export async function createTenantWithUser(
  admin: Pool,
  opts: { slug: string; name: string; email: string; role?: AppRole },
): Promise<TenantFixture> {
  const { rows: [tenant] } = await admin.query(
    "insert into public.tenants (slug, name) values ($1, $2) returning id",
    [opts.slug, opts.name],
  );
  const { rows: [user] } = await admin.query(
    `insert into "user" (id, name, email, "emailVerified") values (gen_random_uuid()::text, $1, $2, true) returning id`,
    [opts.name, opts.email],
  );
  const { rows: [profile] } = await admin.query(
    "insert into public.profiles (auth_user_id) values ($1) returning id",
    [user.id],
  );
  await admin.query(
    "insert into public.tenant_memberships (tenant_id, user_id, role) values ($1, $2, $3)",
    [tenant.id, profile.id, opts.role ?? "company_admin"],
  );
  return { tenantId: tenant.id, profileId: profile.id, authUserId: user.id };
}

export async function cleanupFixture(admin: Pool, fixture: TenantFixture) {
  await admin.query("delete from public.tenant_memberships where tenant_id = $1", [fixture.tenantId]);
  await admin.query("delete from public.profiles where id = $1", [fixture.profileId]);
  await admin.query(`delete from "user" where id = $1`, [fixture.authUserId]);
  await admin.query("delete from public.tenants where id = $1", [fixture.tenantId]);
}
