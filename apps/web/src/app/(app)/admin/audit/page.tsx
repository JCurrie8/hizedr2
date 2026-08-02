import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";

export default async function TenantAuditPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin") {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <p className="text-sm text-muted">Only a company admin can view the audit log.</p>
      </div>
    );
  }

  const events = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (c) =>
    c
      .query(
        `select al.id, al.action, al.target_type, al.target_id, al.metadata, al.created_at, p.full_name as actor_name
         from public.audit_log al
         left join public.profiles p on p.id = al.actor_user_id
         where al.tenant_id = $1
         order by al.created_at desc
         limit 100`,
        [ctx.tenant.id],
      )
      .then((r) => r.rows),
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Audit log</h1>
      <p className="mt-2 text-sm text-muted">Every privileged change in {ctx.tenant.name}, most recent first.</p>

      <ul className="mt-6 divide-y divide-line rounded-md border border-line">
        {events.map((e) => (
          <li key={e.id} className="px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-teal-deep">{e.action}</span>
              <span className="text-muted">{e.actor_name ?? "system"}</span>
              <span className="ml-auto text-xs text-muted">{new Date(e.created_at).toLocaleString()}</span>
            </div>
            {e.target_type && (
              <div className="mt-1 text-xs text-muted">
                {e.target_type} · {e.target_id}
              </div>
            )}
          </li>
        ))}
        {events.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">No activity yet.</li>}
      </ul>
    </div>
  );
}
