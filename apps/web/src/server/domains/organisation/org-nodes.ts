import type { PoolClient } from "@neondatabase/serverless";
import type { OrgNode, OrgNodeType } from "@hized/contracts";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** org_node_versions.path is ltree — labels can't contain hyphens. */
function pathLabel(orgNodeId: string): string {
  return orgNodeId.replace(/-/g, "_");
}

function mapRow(row: {
  org_node_id: string;
  node_type: OrgNodeType;
  name: string;
  parent_id: string | null;
  manager_user_id: string | null;
  linked_user_id: string | null;
  path: string;
  valid_from: string;
  valid_to: string | null;
}): OrgNode {
  return {
    orgNodeId: row.org_node_id,
    nodeType: row.node_type,
    name: row.name,
    parentId: row.parent_id,
    managerUserId: row.manager_user_id,
    linkedUserId: row.linked_user_id,
    path: row.path,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

/**
 * Creates a stable org_nodes identity row plus its first effective-dated
 * version (ORG-001). Every RLS-protected write below relies on the
 * caller already running inside withUserContext({ userId, tenantId }) —
 * the "org_nodes/org_node_versions: company_admin write" policies are
 * what actually enforce who can call this, not application code.
 */
export async function createOrgNode(
  client: PoolClient,
  opts: {
    tenantId: string;
    nodeType: OrgNodeType;
    name: string;
    parentId?: string | null;
    managerUserId?: string | null;
    linkedUserId?: string | null;
    validFrom?: string;
  },
): Promise<OrgNode> {
  const validFrom = opts.validFrom ?? todayIso();
  if (validFrom > todayIso()) {
    throw new Error("Future-dated hierarchy changes are not supported yet.");
  }
  const { rows: [node] } = await client.query(
    "insert into public.org_nodes (tenant_id, node_type, linked_user_id) values ($1, $2, $3) returning id",
    [opts.tenantId, opts.nodeType, opts.linkedUserId ?? null],
  );

  let parentPath = "";
  if (opts.parentId) {
    const { rows: [parent] } = await client.query(
      "select path from public.org_node_versions where org_node_id = $1 and valid_to is null",
      [opts.parentId],
    );
    if (!parent) throw new Error(`Parent org node ${opts.parentId} has no current version`);
    parentPath = `${parent.path}.`;
  }
  const path = `${parentPath}${pathLabel(node.id)}`;

  const { rows: [version] } = await client.query(
    `insert into public.org_node_versions
      (org_node_id, tenant_id, parent_id, name, manager_user_id, path, valid_from)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [node.id, opts.tenantId, opts.parentId ?? null, opts.name, opts.managerUserId ?? null, path, validFrom],
  );

  return mapRow({ ...version, org_node_id: node.id, linked_user_id: opts.linkedUserId ?? null, node_type: opts.nodeType });
}

/**
 * Effective-dated edit (ORG-004): closes the current version (valid_to =
 * today) and opens a new one, rather than updating in place — history
 * stays queryable "as of" any past date. If parentId changes, every
 * currently-active descendant also gets a new version with its path
 * re-prefixed, so current_user_scope_paths() (which reads TODAY's path)
 * keeps matching the moved subtree — without this, a reorg would silently
 * break drill-down for everyone scoped to nodes under the moved node,
 * since their stored path would still carry the pre-move prefix.
 */
export async function editOrgNode(
  client: PoolClient,
  opts: {
    orgNodeId: string;
    tenantId: string;
    name: string;
    parentId?: string | null;
    managerUserId?: string | null;
    validFrom?: string;
  },
): Promise<OrgNode> {
  const validFrom = opts.validFrom ?? todayIso();
  if (validFrom !== todayIso()) {
    throw new Error("Hierarchy edits must take effect today until scheduled/backdated reorganisation is implemented.");
  }

  const { rows: [current] } = await client.query(
    "select * from public.org_node_versions where org_node_id = $1 and valid_to is null for update",
    [opts.orgNodeId],
  );
  if (!current) throw new Error(`Org node ${opts.orgNodeId} has no current version`);

  const parentChanged = opts.parentId !== undefined && opts.parentId !== current.parent_id;

  let newPath = current.path;
  if (parentChanged) {
    let parentPath = "";
    if (opts.parentId) {
      const { rows: [parent] } = await client.query(
        `select path, path <@ $2::ltree as would_create_cycle
         from public.org_node_versions
         where org_node_id = $1 and valid_to is null
         for update`,
        [opts.parentId, current.path],
      );
      if (!parent) throw new Error(`Parent org node ${opts.parentId} has no current version`);
      if (parent.would_create_cycle) {
        throw new Error("Cannot move an organisation node beneath itself or one of its descendants.");
      }
      parentPath = `${parent.path}.`;
    }
    newPath = `${parentPath}${pathLabel(opts.orgNodeId)}`;
  }

  await client.query(
    "update public.org_node_versions set valid_to = $1 where org_node_id = $2 and valid_to is null",
    [validFrom, opts.orgNodeId],
  );

  const { rows: [{ node_type: nodeType, linked_user_id: linkedUserId }] } = await client.query(
    "select node_type, linked_user_id from public.org_nodes where id = $1",
    [opts.orgNodeId],
  );

  const { rows: [version] } = await client.query(
    `insert into public.org_node_versions
      (org_node_id, tenant_id, parent_id, name, manager_user_id, path, valid_from)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      opts.orgNodeId,
      opts.tenantId,
      opts.parentId !== undefined ? opts.parentId : current.parent_id,
      opts.name,
      opts.managerUserId !== undefined ? opts.managerUserId : current.manager_user_id,
      newPath,
      validFrom,
    ],
  );

  if (parentChanged) {
    await cascadeDescendantPaths(client, {
      tenantId: opts.tenantId,
      oldPath: current.path,
      newPath,
      validFrom,
    });
  }

  return mapRow({ ...version, org_node_id: opts.orgNodeId, linked_user_id: linkedUserId, node_type: nodeType });
}

async function cascadeDescendantPaths(
  client: PoolClient,
  opts: { tenantId: string; oldPath: string; newPath: string; validFrom: string },
): Promise<void> {
  const { rows: descendants } = await client.query(
    `select * from public.org_node_versions
     where tenant_id = $1 and valid_to is null and path <@ $2::ltree and path != $2::ltree
     order by nlevel(path)
     for update`,
    [opts.tenantId, opts.oldPath],
  );

  for (const d of descendants) {
    const suffix = d.path.slice(opts.oldPath.length); // includes leading "."
    const newDescendantPath = `${opts.newPath}${suffix}`;

    await client.query(
      "update public.org_node_versions set valid_to = $1 where org_node_id = $2 and valid_to is null",
      [opts.validFrom, d.org_node_id],
    );
    await client.query(
      `insert into public.org_node_versions
        (org_node_id, tenant_id, parent_id, name, manager_user_id, path, valid_from)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [d.org_node_id, opts.tenantId, d.parent_id, d.name, d.manager_user_id, newDescendantPath, opts.validFrom],
    );
  }
}

/**
 * Closes the current version with no replacement — the node has no
 * "current" state after validFrom. Refuses if it still has active
 * children, so a reorg can't silently orphan/hide a whole subtree; move
 * or deactivate children first.
 */
export async function deactivateOrgNode(
  client: PoolClient,
  opts: { orgNodeId: string; validFrom?: string },
): Promise<void> {
  const validFrom = opts.validFrom ?? todayIso();
  if (validFrom !== todayIso()) {
    throw new Error("Hierarchy deactivation must take effect today until scheduled/backdated changes are implemented.");
  }

  const { rows: children } = await client.query(
    "select 1 from public.org_node_versions where parent_id = $1 and valid_to is null limit 1",
    [opts.orgNodeId],
  );
  if (children.length > 0) {
    throw new Error("Cannot deactivate a node that still has active children — move or deactivate them first.");
  }

  const { rowCount } = await client.query(
    "update public.org_node_versions set valid_to = $1 where org_node_id = $2 and valid_to is null",
    [validFrom, opts.orgNodeId],
  );
  if (rowCount === 0) throw new Error(`Org node ${opts.orgNodeId} has no current version to deactivate`);
}

/**
 * Full tree as of a given date (default: today), scoped by RLS to
 * whatever current_user_scope_paths() permits — a caller only ever sees
 * the subtree(s) they have access to, never the whole tenant unless
 * they're a company_admin/platform_admin (see 0003_rls.sql).
 */
export async function listOrgTree(
  client: PoolClient,
  opts: { tenantId: string; asOf?: string },
): Promise<OrgNode[]> {
  const asOf = opts.asOf ?? todayIso();
  const { rows } = await client.query(
    `select v.*, n.node_type, n.linked_user_id
     from public.org_node_versions v
     join public.org_nodes n on n.id = v.org_node_id
     where v.tenant_id = $1 and v.valid_from <= $2 and (v.valid_to is null or v.valid_to > $2)
     order by v.path`,
    [opts.tenantId, asOf],
  );
  return rows.map(mapRow);
}
