import { headers } from "next/headers";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { InviteForm } from "./InviteForm";

export default async function UsersPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${h.get("host")}`;

  const canManage = ctx.role === "company_admin";

  const [members, invitations] = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (c) => {
    const { rows: memberRows } = await c.query(
      `select p.id, p.full_name, m.role, m.status
       from public.tenant_memberships m
       join public.profiles p on p.id = m.user_id
       where m.tenant_id = $1
       order by m.created_at`,
      [ctx.tenant.id],
    );
    const { rows: inviteRows } = await c.query(
      `select id, email, role, status, expires_at
       from public.invitations
       where tenant_id = $1
       order by created_at desc`,
      [ctx.tenant.id],
    );
    return [memberRows, inviteRows];
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Users</h1>

      {canManage && (
        <div className="mt-6">
          <InviteForm origin={origin} />
        </div>
      )}

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Members</h2>
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="font-medium text-text">{m.full_name ?? "(no name yet)"}</span>
            <span className="text-muted">{m.role.replace("_", " ")}</span>
            <span className="ml-auto font-mono text-xs uppercase text-muted">{m.status}</span>
          </li>
        ))}
        {members.length === 0 && <li className="px-3 py-4 text-sm text-muted">No members yet.</li>}
      </ul>

      {canManage && (
        <>
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Invitations</h2>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-medium text-text">{i.email}</span>
                <span className="text-muted">{i.role.replace("_", " ")}</span>
                <span className="ml-auto font-mono text-xs uppercase text-muted">{i.status}</span>
              </li>
            ))}
            {invitations.length === 0 && <li className="px-3 py-4 text-sm text-muted">No invitations yet.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
