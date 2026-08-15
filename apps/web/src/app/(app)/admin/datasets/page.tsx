import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import {
  DATASET_REFRESH_CADENCES,
  GOVERNED_FIELD_ROLES,
  MAX_PROJECTED_FIELDS,
  deriveDatasetFieldsFromPipeline,
  listGovernedDatasetGovernance,
  listPipelinePublicationCandidates,
  toGovernedFieldKey,
} from "@/server/domains/analytics/governed-datasets";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import {
  publishGovernedDatasetAction,
  refreshRecordProjectionsAction,
  saveProjectionRuleAction,
  updateFieldGovernanceAction,
} from "./actions";

const inputClasses = "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";

function formatDateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timezone })
    .format(new Date(value));
}

export default async function GovernedDatasetsPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") redirect(tenantHref("/dashboard"));

  const result = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" })) return null;
      return {
        datasets: await listGovernedDatasetGovernance(client, { tenantId: ctx.tenant.id }),
        candidates: await listPipelinePublicationCandidates(client, { tenantId: ctx.tenant.id }),
      };
    },
  );
  if (!result) redirect(tenantHref("/home"));
  const { datasets, candidates } = result;
  const publishable = candidates.filter((candidate) => candidate.publishedDatasetId === null);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Pulse governance</p>
          <h1 className="mt-2 font-display text-3xl font-bold text-ink">Governed datasets</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
            A governed dataset is the published, business-readable view of a Connect pipeline. It names the fields KPIs may
            use, marks the ones that must stay inside the operator boundary, and controls whether Pulse can show the
            individual records behind an approved number.
          </p>
        </div>
        <Link href={tenantHref("/admin/kpis")} className="text-sm font-semibold text-teal-deep hover:underline">KPI catalogue</Link>
      </div>

      <section className="mt-7 rounded-xl border border-line bg-panel p-5 sm:p-6" aria-labelledby="publish-heading">
        <h2 id="publish-heading" className="font-display text-xl font-semibold text-ink">Publish a dataset from Connect</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          The field catalogue is taken from the pipeline&rsquo;s configured output. Fields whose names suggest personal or
          contractual detail start as sensitive, and you can change every role and sensitivity decision below before any
          record is projected.
        </p>
        {publishable.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line bg-canvas p-4 text-sm leading-6 text-muted">
            {candidates.length === 0
              ? <>No pipelines are available yet. Create and run one in <Link href={tenantHref("/admin/connect")} className="font-semibold text-teal-deep hover:underline">Connect</Link> first.</>
              : "Every pipeline already publishes a governed dataset."}
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            {publishable.map((candidate) => {
              const derived = deriveDatasetFieldsFromPipeline(candidate.fieldMappings, candidate.keyColumns);
              return (
                <details key={candidate.id} className="rounded-lg border border-line bg-canvas p-4">
                  <summary className="cursor-pointer font-semibold text-ink">
                    {candidate.name}
                    <span className="ml-2 font-normal text-xs text-muted">
                      {candidate.connectorName} · {candidate.curatedRecordCount.toLocaleString("en-GB")} curated records · {derived.length} publishable fields
                    </span>
                  </summary>
                  {derived.length === 0 ? (
                    <p className="mt-3 text-sm text-danger">
                      This pipeline has no included fields yet. Configure it in Connect before publishing.
                    </p>
                  ) : (
                    <form action={publishGovernedDatasetAction} className="mt-4 grid gap-4 sm:grid-cols-2">
                      <input type="hidden" name="pipelineId" value={candidate.id} />
                      <label className="text-sm font-semibold text-ink">Dataset name
                        <input name="name" required maxLength={120} defaultValue={candidate.name} className={inputClasses} />
                      </label>
                      <label className="text-sm font-semibold text-ink">Dataset key
                        <input name="datasetKey" required pattern="[a-z][a-z0-9_]*" maxLength={60} defaultValue={toGovernedFieldKey(candidate.name)} className={`${inputClasses} font-mono`} />
                      </label>
                      <label className="text-sm font-semibold text-ink">Subject area
                        <input name="subjectArea" required maxLength={80} placeholder="Service delivery" className={inputClasses} />
                      </label>
                      <label className="text-sm font-semibold text-ink">Refresh cadence
                        <select name="refreshCadence" defaultValue="daily" className={inputClasses}>
                          {DATASET_REFRESH_CADENCES.map((cadence) => <option key={cadence} value={cadence}>{cadence}</option>)}
                        </select>
                      </label>
                      <label className="text-sm font-semibold text-ink">Expected latency (hours)
                        <input type="number" name="expectedLatencyHours" min={1} max={168} defaultValue={24} className={inputClasses} />
                      </label>
                      <label className="text-sm font-semibold text-ink">Description
                        <input name="description" maxLength={500} placeholder="What this data represents" className={inputClasses} />
                      </label>
                      <p className="text-xs leading-5 text-muted sm:col-span-2">
                        Fields to publish: {derived.map((field) => `${field.fieldKey}${field.isSensitive ? " (sensitive)" : ""}`).join(", ")}
                      </p>
                      <div className="sm:col-span-2">
                        <button className="rounded-lg bg-teal-deep px-4 py-2.5 text-sm font-semibold text-white">Publish governed dataset</button>
                      </div>
                    </form>
                  )}
                </details>
              );
            })}
          </div>
        )}
      </section>

      {datasets.length === 0 ? (
        <section className="mt-6 rounded-xl border border-dashed border-line bg-panel p-6 sm:p-8">
          <h2 className="font-display text-xl font-semibold text-ink">No governed datasets yet</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Publish one above, then define its KPIs in the catalogue. Pulse resolves every number from these definitions
            under each viewer&rsquo;s own permissions.
          </p>
        </section>
      ) : (
        <section className="mt-6 space-y-5" aria-label="Governed datasets">
          {datasets.map((dataset) => {
            const nonSensitive = dataset.fields.filter((field) => !field.isSensitive);
            const textFields = nonSensitive.filter((field) => field.dataType === "text");
            const timeFields = nonSensitive.filter((field) => field.dataType === "date" || field.dataType === "timestamp");
            const numericFields = nonSensitive.filter((field) => field.dataType === "integer" || field.dataType === "decimal");
            const rule = dataset.projectionRule;
            const canProject = dataset.sourcePipelineId !== null && textFields.length > 0 && timeFields.length > 0;

            return (
              <article key={dataset.id} className="rounded-xl border border-line bg-panel p-5 sm:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-xl font-semibold text-ink">{dataset.name}</h2>
                      <span className="rounded-full bg-canvas px-2.5 py-1 text-[11px] font-semibold capitalize text-muted">{dataset.status}</span>
                    </div>
                    {dataset.description && <p className="mt-2 text-sm leading-6 text-muted">{dataset.description}</p>}
                  </div>
                  <p className="shrink-0 font-mono text-xs text-muted">{dataset.key}</p>
                </div>

                <dl className="mt-5 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div><dt className="text-xs text-muted">Source pipeline</dt><dd className="mt-1 font-semibold text-ink">{dataset.sourcePipelineName ?? "Not linked"}</dd></div>
                  <div><dt className="text-xs text-muted">Curated records</dt><dd className="mt-1 font-semibold text-ink">{dataset.curatedRecordCount.toLocaleString("en-GB")}</dd></div>
                  <div><dt className="text-xs text-muted">Projected records</dt><dd className="mt-1 font-semibold text-ink">{dataset.projectedRecordCount.toLocaleString("en-GB")}</dd></div>
                  <div><dt className="text-xs text-muted">Approved KPIs</dt><dd className="mt-1 font-semibold text-ink">{dataset.approvedKpiCount}</dd></div>
                </dl>

                <details className="mt-5 border-t border-line pt-4">
                  <summary className="cursor-pointer text-sm font-semibold text-teal-deep">Field catalogue ({dataset.fields.length})</summary>
                  <form action={updateFieldGovernanceAction} className="mt-4">
                    <input type="hidden" name="datasetId" value={dataset.id} />
                    <div className="overflow-x-auto rounded-lg border border-line">
                      <table className="w-full min-w-[640px] text-left text-xs">
                        <thead>
                          <tr className="border-b border-line bg-canvas uppercase tracking-wide text-muted">
                            <th className="px-3 py-2.5">Field</th>
                            <th className="px-3 py-2.5">Source column</th>
                            <th className="px-3 py-2.5">Type</th>
                            <th className="px-3 py-2.5">Role</th>
                            <th className="px-3 py-2.5">Sensitive</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dataset.fields.map((field) => (
                            <tr key={field.id} className="border-b border-line/70 last:border-0">
                              <th className="px-3 py-2.5 font-medium text-ink">
                                {field.name}
                                <input type="hidden" name="fieldKey" value={field.fieldKey} />
                                <span className="ml-2 font-mono text-[11px] font-normal text-muted">{field.fieldKey}</span>
                              </th>
                              <td className="px-3 py-2.5 font-mono text-[11px] text-muted">{field.sourceField}</td>
                              <td className="px-3 py-2.5 text-muted">{field.dataType}</td>
                              <td className="px-3 py-2.5">
                                <select name={`role:${field.fieldKey}`} defaultValue={field.fieldRole} className="rounded-md border border-line bg-white px-2 py-1 text-xs" aria-label={`Role for ${field.name}`}>
                                  {GOVERNED_FIELD_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                                </select>
                              </td>
                              <td className="px-3 py-2.5">
                                <input type="checkbox" name={`sensitive:${field.fieldKey}`} defaultChecked={field.isSensitive} aria-label={`Mark ${field.name} sensitive`} className="h-4 w-4" />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted">
                      Marking a field sensitive removes it from record projection and discards the projections already
                      published for this dataset, in the same transaction.
                    </p>
                    <button className="mt-3 rounded-lg border border-teal-deep px-4 py-2 text-sm font-semibold text-teal-deep">Save field governance</button>
                  </form>
                </details>

                <details className="mt-4 border-t border-line pt-4" open={rule !== null}>
                  <summary className="cursor-pointer text-sm font-semibold text-teal-deep">
                    Record drill-through {rule ? `· ${rule.status}` : "· not configured"}
                  </summary>
                  {!canProject ? (
                    <p className="mt-3 rounded-lg border border-dashed border-line bg-canvas p-4 text-sm leading-6 text-muted">
                      Record drill-through needs a dataset published from a Connect pipeline with at least one non-sensitive
                      text field (matched against your organisation codes) and one non-sensitive date field.
                    </p>
                  ) : (
                    <>
                      <form action={saveProjectionRuleAction} className="mt-4 grid gap-4 sm:grid-cols-2">
                        <input type="hidden" name="datasetId" value={dataset.id} />
                        <label className="text-sm font-semibold text-ink">Organisation code field
                          <select name="orgCodeFieldKey" defaultValue={rule?.orgCodeFieldKey ?? ""} className={inputClasses}>
                            {textFields.map((field) => <option key={field.fieldKey} value={field.fieldKey}>{field.name}</option>)}
                          </select>
                          <span className="mt-1 block text-xs font-normal leading-5 text-muted">Matched against the code on each organisation node.</span>
                        </label>
                        <label className="text-sm font-semibold text-ink">Record date field
                          <select name="occurredAtFieldKey" defaultValue={rule?.occurredAtFieldKey ?? ""} className={inputClasses}>
                            {timeFields.map((field) => <option key={field.fieldKey} value={field.fieldKey}>{field.name}</option>)}
                          </select>
                          <span className="mt-1 block text-xs font-normal leading-5 text-muted">Places each record inside a KPI reporting period.</span>
                        </label>
                        <label className="text-sm font-semibold text-ink">Contribution field
                          <select name="measureFieldKey" defaultValue={rule?.measureFieldKey ?? ""} className={inputClasses}>
                            <option value="">No contribution value</option>
                            {numericFields.map((field) => <option key={field.fieldKey} value={field.fieldKey}>{field.name}</option>)}
                          </select>
                          <span className="mt-1 block text-xs font-normal leading-5 text-muted">Optional. Must also be projected below.</span>
                        </label>
                        <label className="text-sm font-semibold text-ink">Status
                          <select name="status" defaultValue={rule?.status ?? "active"} className={inputClasses}>
                            <option value="active">Active</option>
                            <option value="disabled">Disabled (withdraws published records)</option>
                          </select>
                        </label>
                        <label className="text-sm font-semibold text-ink">Record limit
                          <input type="number" name="maxRecords" min={100} max={50000} step={100} defaultValue={rule?.maxRecords ?? 5000} className={inputClasses} />
                        </label>
                        <fieldset className="sm:col-span-2">
                          <legend className="text-sm font-semibold text-ink">Fields visible in drill-through (max {MAX_PROJECTED_FIELDS})</legend>
                          <div className="mt-2 flex flex-wrap gap-3">
                            {nonSensitive.map((field) => (
                              <label key={field.fieldKey} className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink">
                                <input
                                  type="checkbox"
                                  name="projectedFieldKeys"
                                  value={field.fieldKey}
                                  defaultChecked={rule ? rule.projectedFieldKeys.includes(field.fieldKey) : false}
                                  className="h-4 w-4"
                                />
                                {field.name}
                              </label>
                            ))}
                          </div>
                          <p className="mt-2 text-xs leading-5 text-muted">Sensitive fields are not listed and can never be projected.</p>
                        </fieldset>
                        <div className="sm:col-span-2">
                          <button className="rounded-lg bg-teal-deep px-4 py-2.5 text-sm font-semibold text-white">Save projection rule</button>
                        </div>
                      </form>

                      {rule && (
                        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs leading-5 text-muted">
                            {rule.lastProjectedAt
                              ? `Last projected ${formatDateTime(rule.lastProjectedAt, ctx.tenant.timezone)} · ${rule.lastProjectedRecordCount.toLocaleString("en-GB")} projected · ${rule.lastUnmatchedRecordCount.toLocaleString("en-GB")} unmatched`
                              : "Not projected yet."}
                          </p>
                          <form action={refreshRecordProjectionsAction}>
                            <input type="hidden" name="datasetId" value={dataset.id} />
                            <button className="rounded-lg border border-teal-deep px-4 py-2 text-sm font-semibold text-teal-deep">Refresh projections</button>
                          </form>
                        </div>
                      )}
                    </>
                  )}
                </details>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
