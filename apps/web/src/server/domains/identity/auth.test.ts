import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { auth } from "./auth";
import { acceptInvitationByToken, hashToken } from "./invitations";

/**
 * Proves the invite-gated signup flow end to end through Better Auth's
 * real API (not a mock) against the real Neon database: an uninvited
 * email is rejected, an invited one creates a working profile + active
 * tenant_membership and flips the invitation to accepted.
 */
describe("invite-gated signup", () => {
  const admin = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.DATABASE_URL });
  let tenantId: string;
  const testEmails: string[] = [];

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
    await admin.query(
      `delete from public.profiles p using public."user" u
       where p.auth_user_id = u.id and u.email = any($1::text[])`,
      [testEmails],
    );
    await admin.query(`delete from public."user" where email = any($1::text[])`, [testEmails]);
    await admin.query("delete from public.tenants where id = $1", [tenantId]);
    await app.end();
    await admin.end();
  });

  it("rejects signup for an email with no pending invitation", async () => {
    const email = `uninvited-${Date.now()}@test.local`;
    testEmails.push(email);
    await expect(
      auth.api.signUpEmail({
        body: { email, name: "Uninvited", password: "correct-horse-battery-staple" },
        headers: new Headers({ "x-invite-token": "z".repeat(43) }),
      }),
    ).rejects.toThrow();

    const { rows } = await admin.query(`select 1 from "user" where email = $1`, [email]);
    expect(rows).toHaveLength(0); // Better Auth must not have created the user either
  });

  it("rejects signup for an invited email when the secret token is missing", async () => {
    const email = `tokenless-${Date.now()}@test.local`;
    testEmails.push(email);
    await admin.query(
      `insert into public.invitations (tenant_id, email, role, token_hash)
       values ($1, $2, 'employee', $3)`,
      [tenantId, email, hashToken("r".repeat(43))],
    );

    await expect(
      auth.api.signUpEmail({
        body: { email, name: "Tokenless", password: "correct-horse-battery-staple" },
      }),
    ).rejects.toThrow();

    const { rows } = await admin.query(`select 1 from public."user" where email = $1`, [email]);
    expect(rows).toHaveLength(0);
  });

  it("provisions profile + active membership for an invited email", async () => {
    const email = `invited-${Date.now()}@test.local`;
    const rawToken = "v".repeat(43);
    testEmails.push(email);
    await admin.query(
      `insert into public.invitations (tenant_id, email, role, token_hash) values ($1, $2, 'company_admin', $3)`,
      [tenantId, email, hashToken(rawToken)],
    );

    const result = await auth.api.signUpEmail({
      body: { email, name: "Invited Person", password: "correct-horse-battery-staple" },
      headers: new Headers({ "x-invite-token": rawToken }),
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

  it("lets an existing authenticated identity accept an invitation to a second tenant", async () => {
    const stamp = Date.now();
    const email = `existing-${stamp}@test.local`;
    const rawToken = "m".repeat(43);
    const { rows: [user] } = await admin.query(
      `insert into public."user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'Existing User', $1, true) returning id`,
      [email],
    );
    const { rows: [profile] } = await admin.query(
      "insert into public.profiles (auth_user_id, full_name) values ($1, 'Existing User') returning id",
      [user.id],
    );
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'employee')",
      [tenantId, profile.id],
    );
    const { rows: [secondTenant] } = await admin.query(
      "insert into public.tenants (slug, name) values ($1, 'Second Tenant') returning id",
      [`existing-user-${stamp}`],
    );
    await admin.query(
      `insert into public.invitations (tenant_id, email, role, token_hash)
       values ($1, $2, 'analyst', $3)`,
      [secondTenant.id, email, hashToken(rawToken)],
    );

    try {
      const client = await app.connect();
      try {
        const accepted = await acceptInvitationByToken(client, { authUserId: user.id, rawToken });
        expect(accepted.profileId).toBe(profile.id);
        expect(accepted.tenantId).toBe(secondTenant.id);
      } finally {
        client.release();
      }

      const { rows } = await admin.query(
        "select tenant_id, role from public.tenant_memberships where user_id = $1 order by tenant_id",
        [profile.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual(expect.objectContaining({ tenant_id: secondTenant.id, role: "analyst" }));
    } finally {
      await admin.query("delete from public.audit_log where tenant_id = $1", [secondTenant.id]);
      await admin.query("delete from public.tenant_memberships where user_id = $1", [profile.id]);
      await admin.query("delete from public.invitations where tenant_id = $1", [secondTenant.id]);
      await admin.query("delete from public.profiles where id = $1", [profile.id]);
      await admin.query(`delete from public."user" where id = $1`, [user.id]);
      await admin.query("delete from public.tenants where id = $1", [secondTenant.id]);
    }
  });
});
