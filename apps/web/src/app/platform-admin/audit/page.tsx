import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";

export default async function PlatformAuditPage() {
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });
  if (ctx.kind !== "platform_admin") return null;

  const events = await withUserContext({ userId: ctx.profileId }, async (c) => {
    const { rows } = await c.query(
        `select al.id, al.tenant_id, t.name as tenant_name, al.action, al.target_type, al.target_id,
                al.metadata, al.created_at, p.full_name as actor_name
         from public.audit_log al
         left join public.profiles p on p.id = al.actor_user_id
         left join public.tenants t on t.id = al.tenant_id
         order by al.created_at desc
         limit 200`,
      );
    await insertAuditLog(c, {
      tenantId: null,
      actorUserId: ctx.profileId,
      action: "platform_admin.viewed_audit_log",
      metadata: { eventCount: rows.length },
    });
    return rows;
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Cross-tenant audit log</h1>
      <p className="mt-2 text-sm text-muted">
        Every privileged action across every tenant, including platform-admin views — section 7.4 of the blueprint.
      </p>

      <ul className="mt-6 divide-y divide-line rounded-md border border-line bg-panel shadow-sm">
        {events.map((e) => (
          <li key={e.id} className="px-3 py-2 text-sm text-muted">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-teal">{e.action}</span>
              <span>{e.actor_name ?? "system"}</span>
              <span className="font-semibold text-ink">{e.tenant_name ?? "(platform-level)"}</span>
              <span className="ml-auto text-xs">{new Date(e.created_at).toLocaleString()}</span>
            </div>
            {e.target_type && (
              <div className="mt-1 text-xs">
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
