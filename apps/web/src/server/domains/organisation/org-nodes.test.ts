import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { withUserContext } from "@hized/db";
import { createOrgNode, editOrgNode, deactivateOrgNode, listOrgTree } from "./org-nodes";

describe("org hierarchy: create, effective-dating, move-cascade, scope", () => {
  const admin = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  let tenantId: string;
  let adminProfileId: string;
  let managerProfileId: string;

  beforeAll(async () => {
    const { rows: [tenant] } = await admin.query(
      "insert into public.tenants (slug, name) values ($1, 'Org Test') returning id",
      [`org-test-${Date.now()}`],
    );
    tenantId = tenant.id;

    for (const [email, role] of [
      [`org-admin-${Date.now()}@test.local`, "company_admin"],
      [`org-mgr-${Date.now()}@test.local`, "manager"],
    ] as const) {
      const { rows: [user] } = await admin.query(
        `insert into "user" (id, name, email, "emailVerified") values (gen_random_uuid()::text, $1, $1, true) returning id`,
        [email],
      );
      const { rows: [profile] } = await admin.query(
        "insert into public.profiles (auth_user_id) values ($1) returning id",
        [user.id],
      );
      await admin.query(
        "insert into public.tenant_memberships (tenant_id, user_id, role) values ($1, $2, $3)",
        [tenantId, profile.id, role],
      );
      if (role === "company_admin") adminProfileId = profile.id;
      else managerProfileId = profile.id;
    }
  });

  afterAll(async () => {
    await admin.query("delete from public.membership_scopes where membership_id in (select id from public.tenant_memberships where tenant_id = $1)", [tenantId]);
    await admin.query("delete from public.org_node_versions where tenant_id = $1", [tenantId]);
    await admin.query("delete from public.org_nodes where tenant_id = $1", [tenantId]);
    await admin.query("delete from public.tenant_memberships where tenant_id = $1", [tenantId]);
    const { rows } = await admin.query(
      `select u.id from "user" u join public.profiles p on p.auth_user_id = u.id
       where p.id = any($1)`,
      [[adminProfileId, managerProfileId]],
    );
    await admin.query("delete from public.profiles where id = any($1)", [[adminProfileId, managerProfileId]]);
    for (const r of rows) await admin.query(`delete from "user" where id = $1`, [r.id]);
    await admin.query("delete from public.tenants where id = $1", [tenantId]);
    await admin.end();
  });

  it("creates a company -> division -> department -> team -> employee chain with correct ltree paths", async () => {
    const tree = await withUserContext({ userId: adminProfileId, tenantId }, async (c) => {
      const company = await createOrgNode(c, { tenantId, nodeType: "company", name: "Acme" });
      const division = await createOrgNode(c, {
        tenantId,
        nodeType: "division",
        name: "UK Services",
        parentId: company.orgNodeId,
      });
      const dept = await createOrgNode(c, {
        tenantId,
        nodeType: "department",
        name: "Ops",
        parentId: division.orgNodeId,
      });
      const team = await createOrgNode(c, { tenantId, nodeType: "team", name: "Install Team", parentId: dept.orgNodeId });
      const employee = await createOrgNode(c, { tenantId, nodeType: "employee", name: "Jamie", parentId: team.orgNodeId });
      return { company, division, dept, team, employee };
    });

    expect(tree.team.path).toBe(
      `${tree.company.path}.${tree.division.path.split(".").pop()}.${tree.dept.path.split(".").pop()}.${tree.team.path.split(".").pop()}`,
    );
    expect(tree.employee.path.startsWith(`${tree.team.path}.`)).toBe(true);
  });

  it("scopes a manager's view to their own subtree, not the whole tenant", async () => {
    const { teamId } = await withUserContext({ userId: adminProfileId, tenantId }, async (c) => {
      const company = await createOrgNode(c, { tenantId, nodeType: "company", name: "ScopeCo" });
      const team = await createOrgNode(c, { tenantId, nodeType: "team", name: "Scoped Team", parentId: company.orgNodeId });
      await createOrgNode(c, { tenantId, nodeType: "employee", name: "Under Team", parentId: team.orgNodeId });

      // Scope the manager to just this team (not the company root).
      const { rows: [membership] } = await c.query(
        "select id from public.tenant_memberships where tenant_id = $1 and user_id = $2",
        [tenantId, managerProfileId],
      );
      await c.query(
        "insert into public.membership_scopes (membership_id, org_node_id) values ($1, $2)",
        [membership.id, team.orgNodeId],
      );
      return { companyId: company.orgNodeId, teamId: team.orgNodeId };
    });

    const managerView = await withUserContext({ userId: managerProfileId, tenantId }, (c) =>
      listOrgTree(c, { tenantId }),
    );
    const seenIds = managerView.map((n) => n.orgNodeId);
    expect(seenIds).toContain(teamId);
    expect(seenIds).not.toContain((await admin.query("select id from public.org_nodes where tenant_id=$1 and node_type='company' order by created_at desc limit 1", [tenantId])).rows[0].id);
  });

  it("effective-dating: an edit preserves the historical version, queryable as-of a past date", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const node = await withUserContext({ userId: adminProfileId, tenantId }, (c) =>
      createOrgNode(c, { tenantId, nodeType: "department", name: "Original Name", validFrom: yesterday }),
    );

    await withUserContext({ userId: adminProfileId, tenantId }, (c) =>
      editOrgNode(c, { orgNodeId: node.orgNodeId, tenantId, name: "Renamed Today", validFrom: today }),
    );

    const asOfYesterday = await withUserContext({ userId: adminProfileId, tenantId }, (c) =>
      listOrgTree(c, { tenantId, asOf: yesterday }),
    );
    const asOfToday = await withUserContext({ userId: adminProfileId, tenantId }, (c) =>
      listOrgTree(c, { tenantId, asOf: today }),
    );

    expect(asOfYesterday.find((n) => n.orgNodeId === node.orgNodeId)?.name).toBe("Original Name");
    expect(asOfToday.find((n) => n.orgNodeId === node.orgNodeId)?.name).toBe("Renamed Today");
  });

  it("moving a node cascades new paths to its active descendants, so scope keeps matching", async () => {
    const { deptB, team, employee } = await withUserContext({ userId: adminProfileId, tenantId }, async (c) => {
      const company = await createOrgNode(c, { tenantId, nodeType: "company", name: "MoveCo" });
      const deptA = await createOrgNode(c, { tenantId, nodeType: "department", name: "Dept A", parentId: company.orgNodeId });
      const deptB = await createOrgNode(c, { tenantId, nodeType: "department", name: "Dept B", parentId: company.orgNodeId });
      const team = await createOrgNode(c, { tenantId, nodeType: "team", name: "Movable Team", parentId: deptA.orgNodeId });
      const employee = await createOrgNode(c, { tenantId, nodeType: "employee", name: "Along For The Ride", parentId: team.orgNodeId });
      return { deptB, team, employee };
    });

    // Scope the manager to the team BEFORE the move.
    await admin.query(
      `insert into public.membership_scopes (membership_id, org_node_id, is_primary)
       select id, $1, false from public.tenant_memberships where tenant_id = $2 and user_id = $3`,
      [team.orgNodeId, tenantId, managerProfileId],
    );

    await withUserContext({ userId: adminProfileId, tenantId }, (c) =>
      editOrgNode(c, { orgNodeId: team.orgNodeId, tenantId, name: team.name, parentId: deptB.orgNodeId }),
    );

    const currentTree = await withUserContext({ userId: adminProfileId, tenantId }, (c) => listOrgTree(c, { tenantId }));
    const movedTeam = currentTree.find((n) => n.orgNodeId === team.orgNodeId)!;
    const movedEmployee = currentTree.find((n) => n.orgNodeId === employee.orgNodeId)!;

    expect(movedTeam.path.startsWith(`${deptB.path}.`)).toBe(true);
    expect(movedEmployee.path.startsWith(`${movedTeam.path}.`)).toBe(true);

    // The manager, still scoped to `team`, must still see the employee
    // after the move — this is exactly what breaks without the cascade.
    const managerView = await withUserContext({ userId: managerProfileId, tenantId }, (c) => listOrgTree(c, { tenantId }));
    expect(managerView.map((n) => n.orgNodeId)).toContain(employee.orgNodeId);

    const scopePaths = await withUserContext({ userId: managerProfileId, tenantId }, (c) =>
      c.query("select unnest(public.current_user_scope_paths())::text as path").then((r) => r.rows.map((row) => row.path)),
    );
    expect(scopePaths).toContain(movedTeam.path);
    expect(scopePaths).not.toContain(team.path);
  });

  it("refuses to move a node beneath its own descendant", async () => {
    const { root, team, employee } = await withUserContext({ userId: adminProfileId, tenantId }, async (c) => {
      const root = await createOrgNode(c, { tenantId, nodeType: "company", name: "Cycle Root" });
      const team = await createOrgNode(c, { tenantId, nodeType: "team", name: "Cycle Team", parentId: root.orgNodeId });
      const employee = await createOrgNode(c, {
        tenantId,
        nodeType: "employee",
        name: "Cycle Employee",
        parentId: team.orgNodeId,
      });
      return { root, team, employee };
    });

    await expect(
      withUserContext({ userId: adminProfileId, tenantId }, (c) =>
        editOrgNode(c, {
          orgNodeId: team.orgNodeId,
          tenantId,
          name: team.name,
          parentId: employee.orgNodeId,
        }),
      ),
    ).rejects.toThrow(/beneath itself or one of its descendants/);

    const tree = await withUserContext({ userId: adminProfileId, tenantId }, (c) => listOrgTree(c, { tenantId }));
    expect(tree.find((node) => node.orgNodeId === team.orgNodeId)?.parentId).toBe(root.orgNodeId);
    expect(tree.find((node) => node.orgNodeId === employee.orgNodeId)?.parentId).toBe(team.orgNodeId);
  });

  it("rejects future-dated hierarchy mutations until scheduling semantics exist", async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await expect(
      withUserContext({ userId: adminProfileId, tenantId }, (c) =>
        createOrgNode(c, { tenantId, nodeType: "department", name: "Future", validFrom: tomorrow }),
      ),
    ).rejects.toThrow(/Future-dated/);
  });

  it("refuses to deactivate a node with active children, succeeds once childless", async () => {
    const { parent, child } = await withUserContext({ userId: adminProfileId, tenantId }, async (c) => {
      const parent = await createOrgNode(c, { tenantId, nodeType: "department", name: "Parent" });
      const child = await createOrgNode(c, { tenantId, nodeType: "team", name: "Child", parentId: parent.orgNodeId });
      return { parent, child };
    });

    await expect(
      withUserContext({ userId: adminProfileId, tenantId }, (c) => deactivateOrgNode(c, { orgNodeId: parent.orgNodeId })),
    ).rejects.toThrow(/active children/);

    await withUserContext({ userId: adminProfileId, tenantId }, (c) => deactivateOrgNode(c, { orgNodeId: child.orgNodeId }));
    await withUserContext({ userId: adminProfileId, tenantId }, (c) => deactivateOrgNode(c, { orgNodeId: parent.orgNodeId }));

    const tree = await withUserContext({ userId: adminProfileId, tenantId }, (c) => listOrgTree(c, { tenantId }));
    expect(tree.map((n) => n.orgNodeId)).not.toContain(parent.orgNodeId);
    expect(tree.map((n) => n.orgNodeId)).not.toContain(child.orgNodeId);
  });
});
