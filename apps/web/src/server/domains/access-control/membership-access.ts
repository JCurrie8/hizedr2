import type { PoolClient } from "@neondatabase/serverless";
import type { AppRole, OrgNodeType } from "@hized/contracts";

export const APP_ROLES = [
  "company_admin",
  "executive",
  "functional_leader",
  "manager",
  "employee",
  "analyst",
] as const satisfies readonly AppRole[];

export const MANAGEABLE_MEMBERSHIP_STATUSES = ["active", "suspended"] as const;
export type ManageableMembershipStatus = (typeof MANAGEABLE_MEMBERSHIP_STATUSES)[number];

export function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

export function isManageableMembershipStatus(value: string): value is ManageableMembershipStatus {
  return (MANAGEABLE_MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

export interface MembershipAccess {
  membershipId: string;
  userId: string;
  fullName: string | null;
  email: string;
  role: AppRole;
  status: string;
  primaryScope: {
    orgNodeId: string;
    nodeType: OrgNodeType;
    name: string;
  } | null;
}

interface MembershipAccessRow {
  membership_id: string;
  user_id: string;
  full_name: string | null;
  email: string;
  role: AppRole;
  status: string;
  org_node_id: string | null;
  node_type: OrgNodeType | null;
  scope_name: string | null;
}

function mapMembership(row: MembershipAccessRow): MembershipAccess {
  return {
    membershipId: row.membership_id,
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    status: row.status,
    primaryScope:
      row.org_node_id && row.node_type && row.scope_name
        ? { orgNodeId: row.org_node_id, nodeType: row.node_type, name: row.scope_name }
        : null,
  };
}

/**
 * Lists membership access for one explicitly scoped tenant. This must run
 * inside withUserContext; RLS remains the isolation boundary and the page
 * additionally restricts the feature to Company Admins.
 */
export async function listMembershipAccess(
  client: PoolClient,
  opts: { tenantId: string },
): Promise<MembershipAccess[]> {
  const { rows } = await client.query<MembershipAccessRow>(
    `select
       m.id as membership_id,
       m.user_id,
       p.full_name,
       u.email,
       m.role,
       m.status,
       scope.org_node_id,
       scope.node_type,
       scope.scope_name
     from public.tenant_memberships m
     join public.profiles p on p.id = m.user_id
     join public."user" u on u.id = p.auth_user_id
     left join lateral (
       select n.id as org_node_id, n.node_type, v.name as scope_name
       from public.membership_scopes s
       join public.org_nodes n on n.id = s.org_node_id
       join public.org_node_versions v on v.org_node_id = n.id
         and v.tenant_id = m.tenant_id
         and v.valid_from <= current_date
         and (v.valid_to is null or v.valid_to > current_date)
       where s.membership_id = m.id and s.is_primary
       order by v.path, n.id
       limit 1
     ) scope on true
     where m.tenant_id = $1
     order by coalesce(p.full_name, u.email), m.created_at`,
    [opts.tenantId],
  );
  return rows.map(mapMembership);
}

/**
 * Changes one member's role/status and primary organisation scope atomically.
 * The target tenant comes from trusted auth context, never from form data.
 *
 * All tenant membership rows are locked first so two admins cannot both
 * demote the final Company Admin concurrently. Self-demotion/suspension is
 * rejected because the RLS write policy correctly requires the actor to
 * remain a Company Admin through the write.
 */
export async function updateMembershipAccess(
  client: PoolClient,
  opts: {
    tenantId: string;
    actorUserId: string;
    membershipId: string;
    role: AppRole;
    status: ManageableMembershipStatus;
    orgNodeId?: string;
  },
): Promise<MembershipAccess> {
  const { rows: lockedMemberships } = await client.query<{
    id: string;
    user_id: string;
    role: AppRole;
    status: string;
  }>(
    `select id, user_id, role, status
     from public.tenant_memberships
     where tenant_id = $1
     order by id
     for update`,
    [opts.tenantId],
  );

  const target = lockedMemberships.find((membership) => membership.id === opts.membershipId);
  if (!target) throw new Error("Member does not belong to this company.");

  const removesAdminAccess = opts.role !== "company_admin" || opts.status !== "active";
  if (target.user_id === opts.actorUserId && target.role === "company_admin" && removesAdminAccess) {
    throw new Error("You cannot demote or suspend your own Company Admin access.");
  }

  if (target.role === "company_admin" && target.status === "active" && removesAdminAccess) {
    const activeAdminCount = lockedMemberships.filter(
      (membership) => membership.role === "company_admin" && membership.status === "active",
    ).length;
    if (activeAdminCount <= 1) {
      throw new Error("Add another active Company Admin before changing the last administrator.");
    }
  }

  if (opts.role !== "company_admin" && !opts.orgNodeId) {
    throw new Error("Choose a company, division, department, team or other organisation scope for this user.");
  }

  if (opts.orgNodeId) {
    const { rowCount } = await client.query(
      `select 1
       from public.org_nodes n
       join public.org_node_versions v on v.org_node_id = n.id
         and v.tenant_id = n.tenant_id
         and v.valid_from <= current_date
         and (v.valid_to is null or v.valid_to > current_date)
       where n.id = $1 and n.tenant_id = $2`,
      [opts.orgNodeId, opts.tenantId],
    );
    if (rowCount === 0) throw new Error("Organisation scope is inactive or does not belong to this company.");
  }

  await client.query(
    `update public.tenant_memberships
     set role = $1, status = $2, updated_at = now()
     where id = $3 and tenant_id = $4`,
    [opts.role, opts.status, opts.membershipId, opts.tenantId],
  );

  await client.query(
    "update public.membership_scopes set is_primary = false where membership_id = $1 and is_primary",
    [opts.membershipId],
  );
  if (opts.role !== "company_admin" && opts.orgNodeId) {
    await client.query(
      `insert into public.membership_scopes (membership_id, org_node_id, is_primary)
       values ($1, $2, true)
       on conflict (membership_id, org_node_id)
       do update set is_primary = excluded.is_primary`,
      [opts.membershipId, opts.orgNodeId],
    );
  }

  const updated = (await listMembershipAccess(client, { tenantId: opts.tenantId })).find(
    (membership) => membership.membershipId === opts.membershipId,
  );
  if (!updated) throw new Error("Updated member could not be read back.");
  return updated;
}
