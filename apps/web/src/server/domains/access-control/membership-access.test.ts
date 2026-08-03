import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { withUserContext } from "@hized/db";
import type { AppRole } from "@hized/contracts";
import { createOrgNode, listOrgTree } from "../organisation/org-nodes";
import { listMembershipAccess, updateMembershipAccess } from "./membership-access";

describe("Company Admin membership access", () => {
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const profileIds: string[] = [];
  const authUserIds: string[] = [];
  let tenantAId: string;
  let tenantBId: string;
  let adminAProfileId: string;
  let adminAMembershipId: string;
  let memberAProfileId: string;
  let memberAMembershipId: string;
  let adminBProfileId: string;
  let memberBProfileId: string;
  let memberBMembershipId: string;
  let companyAId: string;
  let divisionAId: string;
  let teamAId: string;
  let companyBId: string;

  async function addMember(opts: {
    tenantId: string;
    name: string;
    role: AppRole;
  }): Promise<{ profileId: string; membershipId: string }> {
    const email = `${opts.name.toLowerCase().replaceAll(" ", "-")}-${Date.now()}-${profileIds.length}@test.local`;
    const { rows: [user] } = await owner.query(
      `insert into public."user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, $1, $2, true)
       returning id`,
      [opts.name, email],
    );
    const { rows: [profile] } = await owner.query(
      "insert into public.profiles (auth_user_id, full_name) values ($1, $2) returning id",
      [user.id, opts.name],
    );
    const { rows: [membership] } = await owner.query(
      `insert into public.tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, $3)
       returning id`,
      [opts.tenantId, profile.id, opts.role],
    );
    authUserIds.push(user.id);
    profileIds.push(profile.id);
    return { profileId: profile.id, membershipId: membership.id };
  }

  beforeAll(async () => {
    const stamp = Date.now();
    const { rows: [tenantA] } = await owner.query(
      "insert into public.tenants (slug, name) values ($1, 'Access Tenant A') returning id",
      [`access-a-${stamp}`],
    );
    const { rows: [tenantB] } = await owner.query(
      "insert into public.tenants (slug, name) values ($1, 'Access Tenant B') returning id",
      [`access-b-${stamp}`],
    );
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const adminA = await addMember({ tenantId: tenantAId, name: "Admin A", role: "company_admin" });
    const memberA = await addMember({ tenantId: tenantAId, name: "Manager A", role: "employee" });
    const adminB = await addMember({ tenantId: tenantBId, name: "Admin B", role: "company_admin" });
    const memberB = await addMember({ tenantId: tenantBId, name: "Member B", role: "employee" });
    adminAProfileId = adminA.profileId;
    adminAMembershipId = adminA.membershipId;
    memberAProfileId = memberA.profileId;
    memberAMembershipId = memberA.membershipId;
    adminBProfileId = adminB.profileId;
    memberBProfileId = memberB.profileId;
    memberBMembershipId = memberB.membershipId;

    // One genuine identity administers both tenants. This reproduces the
    // high-risk multi-tenant-admin shape from migrations 0006 and 0011.
    await owner.query(
      `insert into public.tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'company_admin')`,
      [tenantBId, adminAProfileId],
    );

    const hierarchyA = await withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, async (client) => {
      const company = await createOrgNode(client, { tenantId: tenantAId, nodeType: "company", name: "Company A" });
      const division = await createOrgNode(client, {
        tenantId: tenantAId,
        nodeType: "division",
        name: "Services Division",
        parentId: company.orgNodeId,
      });
      const team = await createOrgNode(client, {
        tenantId: tenantAId,
        nodeType: "team",
        name: "Delivery Team",
        parentId: division.orgNodeId,
      });
      await client.query(
        "insert into public.membership_scopes (membership_id, org_node_id, is_primary) values ($1, $2, false)",
        [memberAMembershipId, team.orgNodeId],
      );
      return { company, division, team };
    });
    companyAId = hierarchyA.company.orgNodeId;
    divisionAId = hierarchyA.division.orgNodeId;
    teamAId = hierarchyA.team.orgNodeId;

    companyBId = await withUserContext({ userId: adminBProfileId, tenantId: tenantBId }, async (client) => {
      const company = await createOrgNode(client, { tenantId: tenantBId, nodeType: "company", name: "Company B" });
      return company.orgNodeId;
    });
  });

  afterAll(async () => {
    await owner.query("delete from public.tenants where id = any($1::uuid[])", [[tenantAId, tenantBId]]);
    await owner.query("delete from public.profiles where id = any($1::uuid[])", [profileIds]);
    await owner.query("delete from public.\"user\" where id = any($1::text[])", [authUserIds]);
    await owner.end();
  });

  it("separates role from primary scope and preserves secondary scopes", async () => {
    const updated = await withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
      updateMembershipAccess(client, {
        tenantId: tenantAId,
        actorUserId: adminAProfileId,
        membershipId: memberAMembershipId,
        role: "manager",
        status: "active",
        orgNodeId: divisionAId,
      }),
    );

    expect(updated.role).toBe("manager");
    expect(updated.primaryScope).toMatchObject({ orgNodeId: divisionAId, nodeType: "division" });

    const { rows: scopes } = await owner.query(
      `select org_node_id, is_primary
       from public.membership_scopes
       where membership_id = $1
       order by org_node_id`,
      [memberAMembershipId],
    );
    expect(scopes).toHaveLength(2);
    expect(scopes.find((scope) => scope.org_node_id === divisionAId)?.is_primary).toBe(true);
    expect(scopes.find((scope) => scope.org_node_id === teamAId)?.is_primary).toBe(false);

    const managerTree = await withUserContext({ userId: memberAProfileId, tenantId: tenantAId }, (client) =>
      listOrgTree(client, { tenantId: tenantAId }),
    );
    expect(managerTree.map((node) => node.orgNodeId)).toEqual(expect.arrayContaining([divisionAId, teamAId]));
    expect(managerTree.map((node) => node.orgNodeId)).not.toContain(companyAId);
  });

  it("does not allow a non-admin member to be saved without a scope", async () => {
    await expect(
      withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
        updateMembershipAccess(client, {
          tenantId: tenantAId,
          actorUserId: adminAProfileId,
          membershipId: memberAMembershipId,
          role: "employee",
          status: "active",
        }),
      ),
    ).rejects.toThrow(/Choose a company, division, department, team or other organisation scope/);
  });

  it("rejects both a cross-tenant membership and a cross-tenant scope", async () => {
    await expect(
      withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
        updateMembershipAccess(client, {
          tenantId: tenantAId,
          actorUserId: adminAProfileId,
          membershipId: memberBMembershipId,
          role: "manager",
          status: "active",
          orgNodeId: divisionAId,
        }),
      ),
    ).rejects.toThrow("Member does not belong to this company.");

    await expect(
      withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
        updateMembershipAccess(client, {
          tenantId: tenantAId,
          actorUserId: adminAProfileId,
          membershipId: memberAMembershipId,
          role: "manager",
          status: "active",
          orgNodeId: companyBId,
        }),
      ),
    ).rejects.toThrow("Organisation scope is inactive or does not belong to this company.");
  });

  it("does not expose a suspended member from another tenant to a multi-tenant admin", async () => {
    await owner.query("update public.tenant_memberships set status = 'suspended' where id = $1", [memberBMembershipId]);

    const tenantAView = await withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
      client.query("select id from public.profiles where id = $1", [memberBProfileId]),
    );
    expect(tenantAView.rows).toHaveLength(0);

    const tenantBView = await withUserContext({ userId: adminAProfileId, tenantId: tenantBId }, (client) =>
      client.query("select id from public.profiles where id = $1", [memberBProfileId]),
    );
    expect(tenantBView.rows).toHaveLength(1);

    await owner.query("update public.tenant_memberships set status = 'active' where id = $1", [memberBMembershipId]);
  });

  it("keeps suspended members identifiable to their current-tenant Company Admin", async () => {
    await withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
      updateMembershipAccess(client, {
        tenantId: tenantAId,
        actorUserId: adminAProfileId,
        membershipId: memberAMembershipId,
        role: "manager",
        status: "suspended",
        orgNodeId: divisionAId,
      }),
    );

    const members = await withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
      listMembershipAccess(client, { tenantId: tenantAId }),
    );
    expect(members.find((member) => member.membershipId === memberAMembershipId)).toMatchObject({
      fullName: "Manager A",
      status: "suspended",
    });

    await withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
      updateMembershipAccess(client, {
        tenantId: tenantAId,
        actorUserId: adminAProfileId,
        membershipId: memberAMembershipId,
        role: "manager",
        status: "active",
        orgNodeId: divisionAId,
      }),
    );
  });

  it("fails closed when an ordinary manager calls the write domain directly", async () => {
    await expect(
      withUserContext({ userId: memberAProfileId, tenantId: tenantAId }, (client) =>
        updateMembershipAccess(client, {
          tenantId: tenantAId,
          actorUserId: memberAProfileId,
          membershipId: memberAMembershipId,
          role: "manager",
          status: "active",
          orgNodeId: divisionAId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("does not allow the final active Company Admin to remove their own access", async () => {
    await expect(
      withUserContext({ userId: adminAProfileId, tenantId: tenantAId }, (client) =>
        updateMembershipAccess(client, {
          tenantId: tenantAId,
          actorUserId: adminAProfileId,
          membershipId: adminAMembershipId,
          role: "executive",
          status: "active",
          orgNodeId: companyAId,
        }),
      ),
    ).rejects.toThrow("You cannot demote or suspend your own Company Admin access.");
  });
});
