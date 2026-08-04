import Link from "next/link";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { createTenantAction } from "./actions";
import { listPlatformTenants } from "@/server/domains/platform-administration/tenants";

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
    const rows = await listPlatformTenants(c);
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold text-ink">Tenant control centre</h1>
          <p className="mt-1 text-sm text-muted">Provision clients, manage product access and track onboarding.</p>
        </div>
        <div className="text-right text-sm text-muted">
          <div className="font-display text-2xl font-bold text-ink">{tenants.length}</div>
          organisations
        </div>
      </div>

      <form action={createTenantAction} className="mt-6 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-4">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Name
          <input name="name" required className="rounded border border-line bg-white px-2 py-1 text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Slug
          <input
            name="slug"
            required
            pattern="[a-z0-9-]+"
            placeholder="acme-installations"
            className="rounded border border-line bg-white px-2 py-1 text-sm text-ink"
          />
        </label>
        <button type="submit" className="rounded bg-teal px-3 py-1.5 text-sm font-semibold text-ink">
          Create tenant
        </button>
      </form>

      <ul className="mt-6 grid gap-3 md:grid-cols-2">
        {tenants.map((t) => (
          <li key={t.id}>
            <Link href={`/platform-admin/tenants/${t.id}`} className="block rounded-xl border border-line bg-panel p-5 shadow-sm transition hover:border-teal-deep">
              <div className="flex items-start gap-3">
                <div>
                  <div className="font-display text-lg font-semibold text-ink">{t.name}</div>
                  <div className="mt-1 font-mono text-xs text-muted">{t.slug}.hized.app</div>
                </div>
                <span className={`ml-auto rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                  t.status === "active" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
                }`}>{t.status}</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted">
                <span>{t.activeMembers} active members</span>
                <span>{t.pendingInvitations} pending invites</span>
                <span>{t.timezone}</span>
                <span>Created {new Date(t.createdAt).toLocaleDateString("en-GB")}</span>
              </div>
            </Link>
          </li>
        ))}
        {tenants.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted">No tenants yet.</li>
        )}
      </ul>
    </div>
  );
}
