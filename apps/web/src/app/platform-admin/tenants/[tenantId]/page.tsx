import Link from "next/link";
import { notFound } from "next/navigation";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import { getPlatformTenantDetail } from "@/server/domains/platform-administration/tenants";
import {
  updateProductEntitlementAction,
  updateTenantConfigurationAction,
  updateTenantStatusAction,
} from "../../actions";
import { CompanyAdminInviteForm } from "./CompanyAdminInviteForm";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const PRODUCT_LABELS = { pulse: "Pulse", connect: "Connect", canvas: "Canvas" } as const;

export default async function PlatformTenantPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });
  if (ctx.kind !== "platform_admin") return null;

  const detail = await withUserContext({ userId: ctx.profileId, tenantId }, async (client) => {
    const result = await getPlatformTenantDetail(client, tenantId);
    if (result) {
      await insertAuditLog(client, {
        tenantId,
        actorUserId: ctx.profileId,
        action: "platform_admin.viewed_tenant_detail",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { slug: result.tenant.slug },
      });
    }
    return result;
  });
  if (!detail) notFound();

  const onboarding = [
    { label: "Company Admin assigned", complete: detail.companyAdmins.some((admin) => admin.status === "active") },
    { label: "Organisation hierarchy", complete: detail.counts.currentOrgNodes > 0 },
    { label: "Source connector", complete: detail.counts.connectors > 0 },
    { label: "Published governed dataset", complete: detail.counts.publishedDatasets > 0 },
    { label: "Approved KPI", complete: detail.counts.approvedKpis > 0 },
    { label: "Published Pulse/Canvas view", complete: detail.counts.publishedViews > 0 },
  ];
  const completedSteps = onboarding.filter((step) => step.complete).length;
  const isActive = detail.tenant.status === "active";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/platform-admin" className="text-sm text-teal hover:underline">← All tenants</Link>
      <div className="mt-4 flex flex-wrap items-start gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-3xl font-bold text-ink">{detail.tenant.name}</h1>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${
              isActive ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
            }`}>
              {detail.tenant.status}
            </span>
          </div>
          <p className="mt-1 font-mono text-sm text-muted">{detail.tenant.slug}.hized.app</p>
        </div>
        <div className="ml-auto text-right text-xs text-muted">
          <p>Created {new Date(detail.tenant.createdAt).toLocaleDateString("en-GB")}</p>
          <p>Updated {new Date(detail.tenant.updatedAt).toLocaleDateString("en-GB")}</p>
        </div>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Active members", detail.counts.activeMembers],
          ["Pending invites", detail.counts.pendingInvitations],
          ["Connectors", detail.counts.connectors],
          ["Approved KPIs", detail.counts.approvedKpis],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-panel p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
            <p className="mt-2 font-display text-2xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-ink">Tenant configuration</h2>
          <form action={updateTenantConfigurationAction} className="mt-4 grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="flex flex-col gap-1 text-xs text-muted">
              Company name
              <input name="name" required defaultValue={detail.tenant.name} className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              IANA time zone
              <input name="timezone" required defaultValue={detail.tenant.timezone} placeholder="Europe/London" className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Financial year starts
              <select name="financialCalendarStartMonth" defaultValue={detail.tenant.financialCalendarStartMonth} className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink">
                {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Retention days
              <input name="dataRetentionDays" type="number" min="30" max="3650" defaultValue={detail.tenant.dataRetentionDays ?? ""} placeholder="Not yet set" className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink" />
            </label>
            <button className="rounded-md bg-teal px-4 py-2 text-sm font-semibold text-ink sm:col-span-2 sm:justify-self-start">Save configuration</button>
          </form>
        </section>

        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold text-ink">Onboarding</h2>
            <span className="text-sm font-semibold text-teal-deep">{completedSteps}/{onboarding.length}</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-canvas">
            <div className="h-full rounded-full bg-teal" style={{ width: `${(completedSteps / onboarding.length) * 100}%` }} />
          </div>
          <ul className="mt-4 space-y-2 text-sm">
            {onboarding.map((step) => (
              <li key={step.label} className="flex items-center gap-2 text-muted">
                <span className={step.complete ? "text-success" : "text-muted/60"}>{step.complete ? "●" : "○"}</span>
                {step.label}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-panel p-5 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-ink">Products and commercial access</h2>
        <p className="mt-1 text-sm text-muted">Changes are server-enforced across routes, actions and scheduled work.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {detail.entitlements.map((entitlement) => (
            <form key={entitlement.productKey} action={updateProductEntitlementAction} className="rounded-lg border border-line bg-white p-4">
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="productKey" value={entitlement.productKey} />
              <label className="flex flex-col gap-2 text-sm font-semibold text-ink">
                {PRODUCT_LABELS[entitlement.productKey]}
                <select name="status" defaultValue={entitlement.status} className="rounded-md border border-line bg-white px-3 py-2 text-sm font-normal text-ink">
                  <option value="active">Active</option>
                  <option value="trial">Trial</option>
                  <option value="locked">Locked</option>
                </select>
              </label>
              <button className="mt-3 rounded-md border border-teal/50 px-3 py-1.5 text-xs font-semibold text-teal">Update access</button>
            </form>
          ))}
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <CompanyAdminInviteForm tenantId={tenantId} disabled={!isActive} />
        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-ink">Current Company Admins</h2>
          <ul className="mt-3 divide-y divide-line">
            {detail.companyAdmins.map((admin) => (
              <li key={admin.membershipId} className="py-3 text-sm">
                <div className="font-semibold text-ink">{admin.name ?? admin.email}</div>
                <div className="text-xs text-muted">{admin.email} · {admin.status}</div>
              </li>
            ))}
            {detail.companyAdmins.length === 0 && <li className="py-4 text-sm text-amber-800">No Company Admin assigned.</li>}
          </ul>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-amber-300/25 bg-amber-300/[0.04] p-5">
        <h2 className="font-display text-lg font-semibold text-ink">Tenant lifecycle</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Suspension blocks tenant entry and ordinary tenant-scoped database access. It is reversible and does not delete data.
        </p>
        <form action={updateTenantStatusAction} className="mt-4">
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="status" value={isActive ? "suspended" : "active"} />
          <button className={`rounded-md px-4 py-2 text-sm font-semibold ${
            isActive ? "bg-amber-300 text-ink" : "bg-emerald-300 text-ink"
          }`}>
            {isActive ? "Suspend tenant access" : "Reactivate tenant"}
          </button>
        </form>
      </section>
    </div>
  );
}
