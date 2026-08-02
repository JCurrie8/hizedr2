import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { auth } from "./auth";

/**
 * Proves the invite-gated signup flow end to end through Better Auth's
 * real API (not a mock) against the real Neon database: an uninvited
 * email is rejected, an invited one creates a working profile + active
 * tenant_membership and flips the invitation to accepted.
 */
describe("invite-gated signup", () => {
  const admin = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  let tenantId: string;

  beforeAll(async () => {
    const { rows: [tenant] } = await admin.query(
      "insert into public.tenants (slug, name) values ($1, 'Auth Test Tenant') returning id",
      [`auth-test-${Date.now()}`],
    );
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await admin.query("delete from public.audit_log where tenant_id = $1", [tenantId]);
    await admin.query("delete from public.tenant_memberships where tenant_id = $1", [tenantId]);
    await admin.query("delete from public.invitations where tenant_id = $1", [tenantId]);
    await admin.query("delete from public.tenants where id = $1", [tenantId]);
    await admin.end();
  });

  it("rejects signup for an email with no pending invitation", async () => {
    const email = `uninvited-${Date.now()}@test.local`;
    await expect(
      auth.api.signUpEmail({
        body: { email, name: "Uninvited", password: "correct-horse-battery-staple" },
      }),
    ).rejects.toThrow();

    const { rows } = await admin.query(`select 1 from "user" where email = $1`, [email]);
    expect(rows).toHaveLength(0); // Better Auth must not have created the user either
  });

  it("provisions profile + active membership for an invited email", async () => {
    const email = `invited-${Date.now()}@test.local`;
    const tokenHash = "test-fixture-hash-" + Date.now(); // never resolved via a page in this test, hash value is arbitrary
    await admin.query(
      `insert into public.invitations (tenant_id, email, role, token_hash) values ($1, $2, 'company_admin', $3)`,
      [tenantId, email, tokenHash],
    );

    const result = await auth.api.signUpEmail({
      body: { email, name: "Invited Person", password: "correct-horse-battery-staple" },
    });
    expect(result.user?.email).toBe(email);

    const { rows: profileRows } = await admin.query(
      `select p.id from public.profiles p join "user" u on u.id = p.auth_user_id where u.email = $1`,
      [email],
    );
    expect(profileRows).toHaveLength(1);

    const { rows: membershipRows } = await admin.query(
      "select role, status from public.tenant_memberships where tenant_id = $1 and user_id = $2",
      [tenantId, profileRows[0].id],
    );
    expect(membershipRows).toHaveLength(1);
    expect(membershipRows[0].role).toBe("company_admin");
    expect(membershipRows[0].status).toBe("active");

    const { rows: invitationRows } = await admin.query(
      "select status from public.invitations where tenant_id = $1 and email = $2",
      [tenantId, email],
    );
    expect(invitationRows[0].status).toBe("accepted");

    const { rows: auditRows } = await admin.query(
      "select action, actor_user_id from public.audit_log where tenant_id = $1 and action = 'invitation.accepted'",
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_user_id).toBe(profileRows[0].id);
  });
});
