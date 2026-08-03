import { withUserContext } from "@hized/db";
import type { OrgNode, OrgNodeType } from "@hized/contracts";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listOrgTree } from "@/server/domains/organisation/org-nodes";
import { createNodeAction, deactivateNodeAction } from "./actions";

const NODE_TYPES: OrgNodeType[] = [
  "company",
  "division",
  "function",
  "department",
  "region",
  "site",
  "team",
  "employee",
];

function buildChildren(nodes: OrgNode[]): Map<string | null, OrgNode[]> {
  const byParent = new Map<string | null, OrgNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(node);
  }
  return byParent;
}

function NodeRow({
  node,
  byParent,
  depth,
  canManage,
}: {
  node: OrgNode;
  byParent: Map<string | null, OrgNode[]>;
  depth: number;
  canManage: boolean;
}) {
  const children = byParent.get(node.orgNodeId) ?? [];
  return (
    <div style={{ marginLeft: depth * 20 }} className="border-l border-line pl-4 py-2">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wide text-teal-deep">{node.nodeType}</span>
        <span className="font-medium text-text">{node.name}</span>
        {canManage && (
          <form action={deactivateNodeAction}>
            <input type="hidden" name="orgNodeId" value={node.orgNodeId} />
            <button type="submit" className="text-xs text-danger hover:underline">
              Deactivate
            </button>
          </form>
        )}
      </div>
      {canManage && (
        <form action={createNodeAction} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="parentId" value={node.orgNodeId} />
          <select name="nodeType" className="rounded border border-line px-2 py-1 text-xs">
            {NODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            name="name"
            placeholder="New child name"
            required
            className="rounded border border-line px-2 py-1 text-xs"
          />
          <button type="submit" className="rounded bg-navy px-2 py-1 text-xs font-semibold text-white">
            Add child
          </button>
        </form>
      )}
      {children.map((child) => (
        <NodeRow key={child.orgNodeId} node={child} byParent={byParent} depth={depth + 1} canManage={canManage} />
      ))}
    </div>
  );
}

export default async function OrganisationPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null; // layout already handles other cases

  const nodes = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (c) =>
    listOrgTree(c, { tenantId: ctx.tenant.id }),
  );
  const byParent = buildChildren(nodes);
  const roots = byParent.get(null) ?? [];
  const canManage = ctx.role === "company_admin";

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Organisation</h1>
      <p className="mt-2 text-sm text-muted">
        {canManage
          ? "Restructure the hierarchy — every change is effective-dated, never overwritten."
          : "Showing the part of the organisation you have access to."}
      </p>

      {canManage && (
        <form action={createNodeAction} className="mt-6 flex flex-wrap items-center gap-2 rounded-md border border-line p-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">New root node</span>
          <select name="nodeType" className="rounded border border-line px-2 py-1 text-xs">
            {NODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input name="name" placeholder="Name" required className="rounded border border-line px-2 py-1 text-xs" />
          <button type="submit" className="rounded bg-navy px-3 py-1 text-xs font-semibold text-white">
            Add
          </button>
        </form>
      )}

      <div className="mt-6">
        {roots.length === 0 && <p className="text-sm text-muted">No organisation structure yet.</p>}
        {roots.map((node) => (
          <NodeRow key={node.orgNodeId} node={node} byParent={byParent} depth={0} canManage={canManage} />
        ))}
      </div>
    </div>
  );
}
