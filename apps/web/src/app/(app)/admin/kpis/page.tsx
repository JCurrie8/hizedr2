import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { DIMENSION_SEMANTIC_TYPES, listGovernedDimensionOptions, listPublishedDatasetOptions } from "@/server/domains/pulse/kpi-governance";
import { listKpiCatalogue } from "@/server/domains/pulse/kpis";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import {
  approveKpiDraftAction,
  createGovernedDimensionAction,
  createKpiDraftAction,
  createNextKpiVersionAction,
  rejectKpiDraftAction,
  updateKpiDraftAction,
} from "./actions";
import { KpiDefinitionForm } from "./KpiDefinitionForm";

export default async function KpiCataloguePage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") redirect(tenantHref("/dashboard"));

  const { catalogue, datasets, dimensions } = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => ({
      catalogue: await listKpiCatalogue(client, { tenantId: ctx.tenant.id }),
      datasets: await listPublishedDatasetOptions(client, { tenantId: ctx.tenant.id }),
      dimensions: await listGovernedDimensionOptions(client, { tenantId: ctx.tenant.id }),
    }),
  );
  const approvedCount = catalogue.filter((entry) => entry.approvalStatus === "approved").length;
  const draftCount = catalogue.filter((entry) => entry.approvalStatus === "draft").length;

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

      <section aria-label="Catalogue summary" className="mt-7 grid grid-cols-3 gap-3 sm:max-w-2xl">
        <article className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Definitions</p>
          <p className="mt-2 font-display text-3xl font-bold text-ink">{catalogue.length}</p>
        </article>
        <article className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Approved</p>
          <p className="mt-2 font-display text-3xl font-bold text-ink">{approvedCount}</p>
        </article>
        <article className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Drafts</p>
          <p className="mt-2 font-display text-3xl font-bold text-ink">{draftCount}</p>
        </article>
      </section>

      <details className="mt-6 rounded-xl border border-line bg-panel p-5 sm:p-6">
        <summary className="cursor-pointer font-display text-xl font-semibold text-ink">Create a governed KPI</summary>
        <p className="mt-2 text-sm leading-6 text-muted">Analysts and Company Admins can prepare a complete draft. A Company Admin must review it before Pulse can use it.</p>
        {datasets.length ? <KpiDefinitionForm action={createKpiDraftAction} datasets={datasets} dimensions={dimensions} /> : <p className="mt-4 text-sm text-danger">Publish a governed dataset in Connect before creating a KPI.</p>}
      </details>

      <section className="mt-6 rounded-xl border border-line bg-panel p-5 sm:p-6" aria-labelledby="dimension-heading">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Reusable filters</p>
            <h2 id="dimension-heading" className="mt-1 font-display text-xl font-semibold text-ink">Governed dimensions</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Define product, customer, geography or other business categories once. Link them to KPIs so every compatible Pulse visual uses the same member labels.</p>
          </div>
          <span className="text-xs text-muted">{dimensions.length} published</span>
        </div>
        {dimensions.length > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dimensions.map((dimension) => (
              <article key={dimension.id} className="rounded-lg border border-line bg-canvas p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-ink">{dimension.name}</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold capitalize text-muted">{dimension.semanticType}</span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-muted">{dimension.key}</p>
                <p className="mt-3 text-xs leading-5 text-muted">{dimension.members.map((member) => member.label).join(" · ")}</p>
              </article>
            ))}
          </div>
        )}
        <details className="mt-5 border-t border-line pt-4">
          <summary className="cursor-pointer text-sm font-semibold text-teal-deep">Create a dimension</summary>
          <form action={createGovernedDimensionAction} className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-ink">Name<input name="dimensionName" required maxLength={120} placeholder="Customer segment" className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" /></label>
            <label className="text-sm font-semibold text-ink">Key<input name="dimensionKey" required pattern="[a-z][a-z0-9_]*" maxLength={80} placeholder="customer_segment" className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm" /></label>
            <label className="text-sm font-semibold text-ink">Business type<select name="semanticType" className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm">{DIMENSION_SEMANTIC_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <label className="text-sm font-semibold text-ink">Description<input name="description" maxLength={500} placeholder="How the business groups its customers" className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" /></label>
            <label className="text-sm font-semibold text-ink sm:col-span-2">Members <span className="font-normal text-muted">(one per line: key|Display label)</span><textarea name="members" required rows={4} placeholder={"enterprise|Enterprise\nsmall_business|Small business"} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm" /></label>
            <div className="sm:col-span-2"><button className="rounded-lg bg-teal-deep px-4 py-2.5 text-sm font-semibold text-white">Publish dimension</button></div>
          </form>
        </details>
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
                  {entry.businessPurpose ? <p className="mt-2 text-xs leading-5 text-muted"><span className="font-semibold text-ink">Purpose:</span> {entry.businessPurpose}</p> : null}
                </div>
                <p className="shrink-0 font-mono text-xs text-muted">{entry.key}</p>
              </div>
              <dl className="mt-5 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs text-muted">Dataset</dt><dd className="mt-1 font-semibold text-ink">{entry.dataset.name}</dd><dd className="text-xs text-muted">{entry.dataset.subjectArea}</dd></div>
                <div><dt className="text-xs text-muted">Formula reference</dt><dd className="mt-1 font-semibold text-ink">{entry.formulaReference}</dd></div>
                <div><dt className="text-xs text-muted">Owner / reviewer</dt><dd className="mt-1 font-semibold text-ink">{entry.ownerName}</dd><dd className="text-xs text-muted">{entry.reviewerName}</dd></div>
                <div><dt className="text-xs text-muted">Refresh</dt><dd className="mt-1 font-semibold text-ink">{entry.dataset.refreshCadence}</dd></div>
              </dl>
              {entry.approvalStatus === "draft" ? (
                <div className="mt-5 border-t border-line pt-4">
                  <details>
                    <summary className="cursor-pointer text-sm font-semibold text-teal-deep">Edit complete draft contract</summary>
                    <KpiDefinitionForm action={updateKpiDraftAction} datasets={datasets} dimensions={dimensions} definition={entry} />
                  </details>
                  {ctx.role === "company_admin" ? (
                    <div className="mt-4 flex flex-wrap gap-3">
                      <form action={approveKpiDraftAction}><input type="hidden" name="definitionId" value={entry.id} /><button className="rounded-lg bg-teal-deep px-4 py-2 text-sm font-semibold text-white">Approve and publish</button></form>
                      <form action={rejectKpiDraftAction}><input type="hidden" name="definitionId" value={entry.id} /><button className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-danger">Reject draft</button></form>
                    </div>
                  ) : <p className="mt-3 text-xs text-muted">Waiting for Company Admin review.</p>}
                </div>
              ) : null}
              {entry.approvalStatus === "approved" && entry.validTo === null ? (
                <form action={createNextKpiVersionAction} className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end">
                  <input type="hidden" name="definitionId" value={entry.id} />
                  <label className="text-sm font-semibold text-ink">Replacement effective from<input type="date" name="validFrom" required className="mt-1 block rounded-lg border border-line bg-white px-3 py-2 text-sm" /></label>
                  <button className="rounded-lg border border-teal-deep px-4 py-2 text-sm font-semibold text-teal-deep">Draft v{entry.version + 1}</button>
                </form>
              ) : null}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
