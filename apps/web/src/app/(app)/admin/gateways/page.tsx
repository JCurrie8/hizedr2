import Link from "next/link";
import { headers } from "next/headers";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listSqlGateways } from "@/server/domains/connectors/sql-gateways";
import { assertProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { GatewayEnrollmentForm } from "./GatewayEnrollmentForm";
import { revokeGatewayAction } from "./actions";

function statusClasses(status: string): string {
  if (status === "active") return "bg-emerald-50 text-emerald-800";
  if (status === "error" || status === "revoked") return "bg-red-50 text-danger";
  return "bg-amber-50 text-amber-800";
}

export default async function GatewaysPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin") return <div className="mx-auto max-w-4xl px-6 py-10"><h1 className="font-display text-2xl font-bold text-ink">Gateway setup is restricted</h1><p className="mt-3 text-sm text-muted">Only a Company Admin can enrol or revoke a private-network device.</p></div>;
  const [requestHeaders, gateways] = await Promise.all([
    headers(),
    withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
      await assertProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" });
      return listSqlGateways(client, { tenantId: ctx.tenant.id });
    }),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const href = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });

  return <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
    <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Private connectivity</p>
    <h1 className="mt-2 font-display text-3xl font-bold text-ink">Outbound SQL gateways</h1>
    <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">Connect a private SQL Server without opening database or Remote Desktop ports. The Windows worker polls Hized over HTTPS, validates every bounded read locally and returns only the permitted result.</p>
    <div className="mt-5 flex flex-wrap gap-2"><Link href={href("/admin/queries")} className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink">SQL visual studio</Link><Link href={href("/admin/connect")} className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink">Connect</Link></div>

    <div className="mt-8"><GatewayEnrollmentForm /></div>

    <section className="mt-8">
      <h2 className="font-display text-xl font-semibold text-ink">Gateway inventory</h2>
      <div className="mt-4 space-y-3">{gateways.map((gateway) => <article key={gateway.id} className="rounded-xl border border-line bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-semibold text-ink">{gateway.name}</h3><p className="mt-1 text-sm text-muted">{gateway.connectorName}{gateway.database ? ` · ${gateway.server}/${gateway.database}` : ""}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusClasses(gateway.status)}`}>{gateway.status}</span></div>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3"><div><dt className="text-muted">Machine</dt><dd className="mt-1 font-medium text-ink">{gateway.machineName ?? "Not enrolled"}</dd></div><div><dt className="text-muted">Worker</dt><dd className="mt-1 font-medium text-ink">{gateway.workerVersion ?? "—"}</dd></div><div><dt className="text-muted">Last heartbeat</dt><dd className="mt-1 font-medium text-ink">{gateway.lastSeenAt ? new Date(gateway.lastSeenAt).toLocaleString("en-GB") : "Never"}</dd></div></dl>
        {gateway.lastError && <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-danger">{gateway.lastError}</p>}
        {gateway.status !== "revoked" && <form action={revokeGatewayAction} className="mt-4"><input type="hidden" name="gatewayId" value={gateway.id}/><button className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-semibold text-danger">Revoke device and disable connection</button></form>}
      </article>)}{gateways.length === 0 && <div className="rounded-xl border border-dashed border-line bg-panel p-8 text-center text-sm text-muted">No gateway enrolments yet.</div>}</div>
    </section>
  </div>;
}
