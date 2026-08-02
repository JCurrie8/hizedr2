import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { createTenantAction } from "./actions";

export default async function PlatformAdminHome() {
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });
  if (ctx.kind !== "platform_admin") return null; // layout already handles other cases

  // PLATFORM-003: every cross-tenant view by a platform admin is audited,
  // distinguishable from ordinary tenant-scoped activity — this list view
  // spans every tenant at once, so it's exactly the kind of access that
  // needs to be independently visible to an auditor, not just implied by
  // "well, they're a platform admin." tenant_id is null: this isn't about
  // any one tenant, so the audit_log insert policy's platform-level
  // branch applies instead of the tenant-scoped one.
  const tenants = await withUserContext({ userId: ctx.profileId }, async (c) => {
    const { rows } = await c.query("select id, slug, name, status from public.tenants order by name");
    await insertAuditLog(c, {
      tenantId: null,
      actorUserId: ctx.profileId,
      action: "platform_admin.viewed_tenant_list",
      metadata: { tenantCount: rows.length },
    });
    return rows;
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-white">Tenants</h1>

      <form action={createTenantAction} className="mt-6 flex flex-wrap items-end gap-2 rounded-lg border border-white/10 p-4">
        <label className="flex flex-col gap-1 text-xs text-mist">
          Name
          <input name="name" required className="rounded border border-white/20 bg-transparent px-2 py-1 text-sm text-white" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-mist">
          Slug
          <input
            name="slug"
            required
            pattern="[a-z0-9-]+"
            placeholder="acme-installations"
            className="rounded border border-white/20 bg-transparent px-2 py-1 text-sm text-white"
          />
        </label>
        <button type="submit" className="rounded bg-teal px-3 py-1.5 text-sm font-semibold text-ink">
          Create tenant
        </button>
      </form>

      <ul className="mt-6 divide-y divide-white/10 rounded-lg border border-white/10">
        {tenants.map((t) => (
          <li key={t.id} className="flex items-center gap-4 px-4 py-3 text-sm text-mist">
            <span className="font-semibold text-white">{t.name}</span>
            <span className="font-mono text-xs">{t.slug}</span>
            <span className="ml-auto uppercase tracking-wide">{t.status}</span>
          </li>
        ))}
        {tenants.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-mist">No tenants yet.</li>
        )}
      </ul>
    </div>
  );
}
