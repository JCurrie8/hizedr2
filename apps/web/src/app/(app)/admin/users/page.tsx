import { headers } from "next/headers";
import { withUserContext } from "@hized/db";
import type { AppRole, OrgNodeType } from "@hized/contracts";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listMembershipAccess } from "@/server/domains/access-control/membership-access";
import { listOrgTree } from "@/server/domains/organisation/org-nodes";
import { InviteForm, type OrgScopeOption } from "./InviteForm";
import { MemberAccessList } from "./MemberAccessForm";

interface InvitationRow {
  id: string;
  email: string;
  role: AppRole;
  status: string;
  node_type: OrgNodeType | null;
  scope_name: string | null;
}

function roleLabel(role: AppRole): string {
  if (role === "employee") return "End user";
  return role.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

export default async function UsersPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin") {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="font-display text-2xl font-bold text-ink">Users and access</h1>
        <p className="mt-3 text-sm text-muted">Only a Company Admin can configure member access.</p>
      </div>
    );
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${h.get("host")}`;

  const { members, invitations, orgScopes } = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const memberRows = await listMembershipAccess(client, { tenantId: ctx.tenant.id });
      const nodes = await listOrgTree(client, { tenantId: ctx.tenant.id });
      const { rows: invitationRows } = await client.query<InvitationRow>(
        `select i.id, i.email, i.role, i.status, n.node_type, v.name as scope_name
         from public.invitations i
         left join public.org_nodes n on n.id = i.org_node_id
         left join public.org_node_versions v on v.org_node_id = n.id
           and v.tenant_id = i.tenant_id
           and v.valid_from <= current_date
           and (v.valid_to is null or v.valid_to > current_date)
         where i.tenant_id = $1
         order by i.created_at desc`,
        [ctx.tenant.id],
      );
      const scopes: OrgScopeOption[] = nodes.map((node) => ({
        orgNodeId: node.orgNodeId,
        nodeType: node.nodeType,
        name: node.name,
        depth: node.path.split(".").length - 1,
      }));
      return { members: memberRows, invitations: invitationRows, orgScopes: scopes };
    },
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Users and access</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Give every colleague access to Pulse and Canvas, then use their role for capabilities and their primary scope for the records they can see.
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Invite a colleague</h2>
        <div className="mt-2"><InviteForm origin={origin} orgScopes={orgScopes} /></div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Members</h2>
        <MemberAccessList members={members} orgScopes={orgScopes} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Invitations</h2>
        <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-white">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[1.5fr_1fr_1fr_auto] sm:items-center sm:gap-3">
              <span className="truncate font-medium text-text">{invitation.email}</span>
              <span className="text-muted">{roleLabel(invitation.role)}</span>
              <span className="text-muted">
                {invitation.scope_name
                  ? `${invitation.scope_name} (${invitation.node_type})`
                  : invitation.role === "company_admin" ? "Whole company" : "Scope not set"}
              </span>
              <span className="font-mono text-xs uppercase text-muted">{invitation.status}</span>
            </li>
          ))}
          {invitations.length === 0 && <li className="px-4 py-6 text-sm text-muted">No invitations yet.</li>}
        </ul>
      </section>
    </div>
  );
}
