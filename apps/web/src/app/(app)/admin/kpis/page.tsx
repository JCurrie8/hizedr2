import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listKpiCatalogue } from "@/server/domains/pulse/kpis";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

export default async function KpiCataloguePage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") redirect(tenantHref("/dashboard"));

  const catalogue = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    (client) => listKpiCatalogue(client, { tenantId: ctx.tenant.id }),
  );
  const approvedCount = catalogue.filter((entry) => entry.approvalStatus === "approved").length;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Pulse governance</p>
          <h1 className="mt-2 font-display text-3xl font-bold text-ink">KPI catalogue</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
            One controlled definition for every important number. Versions keep approved history stable while Pulse and, later, Canvas reuse the same contract.
          </p>
        </div>
        <Link href={tenantHref("/dashboard")} className="text-sm font-semibold text-teal-deep hover:underline">View Pulse</Link>
      </div>

      <section aria-label="Catalogue summary" className="mt-7 grid grid-cols-2 gap-3 sm:max-w-xl">
        <article className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Definitions</p>
          <p className="mt-2 font-display text-3xl font-bold text-ink">{catalogue.length}</p>
        </article>
        <article className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Approved</p>
          <p className="mt-2 font-display text-3xl font-bold text-ink">{approvedCount}</p>
        </article>
      </section>

      {catalogue.length === 0 ? (
        <section className="mt-6 rounded-xl border border-dashed border-line bg-panel p-6 sm:p-8">
          <h2 className="font-display text-xl font-semibold text-ink">No governed KPIs published yet</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            The underlying contract is ready. The next setup step is to publish a curated dataset from Connect, then define and approve its KPI formula, owner, audience, target rules and dimensions here.
          </p>
        </section>
      ) : (
        <section className="mt-6 space-y-4" aria-label="KPI definitions">
          {catalogue.map((entry) => (
            <article key={entry.id} className="rounded-xl border border-line bg-panel p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-xl font-semibold text-ink">{entry.name}</h2>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${entry.approvalStatus === "approved" ? "bg-emerald-100 text-emerald-900" : "bg-canvas text-muted"}`}>
                      {entry.approvalStatus}
                    </span>
                    <span className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted">v{entry.version}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">{entry.definition}</p>
                </div>
                <p className="shrink-0 font-mono text-xs text-muted">{entry.key}</p>
              </div>
              <dl className="mt-5 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs text-muted">Dataset</dt><dd className="mt-1 font-semibold text-ink">{entry.dataset.name}</dd><dd className="text-xs text-muted">{entry.dataset.subjectArea}</dd></div>
                <div><dt className="text-xs text-muted">Formula reference</dt><dd className="mt-1 font-semibold text-ink">{entry.formulaReference}</dd></div>
                <div><dt className="text-xs text-muted">Owner</dt><dd className="mt-1 font-semibold text-ink">{entry.ownerName}</dd></div>
                <div><dt className="text-xs text-muted">Refresh</dt><dd className="mt-1 font-semibold text-ink">{entry.dataset.refreshCadence}</dd></div>
              </dl>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
