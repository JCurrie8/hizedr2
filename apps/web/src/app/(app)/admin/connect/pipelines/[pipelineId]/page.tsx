import Link from "next/link";
import { headers } from "next/headers";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { getPipelineBuilderConfiguration } from "@/server/domains/connectors/pipeline-configuration";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { redirect } from "next/navigation";
import { savePipelineConfigurationAction } from "./actions";

const typeOptions = [
  ["string", "Text"],
  ["integer", "Whole number"],
  ["numeric", "Number"],
  ["boolean", "Yes / no"],
  ["date", "Date (YYYY-MM-DD)"],
  ["timestamp", "Date and time"],
] as const;

export default async function PipelineBuilderPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    return <div className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted">Pipeline configuration is available to company admins and analysts.</div>;
  }
  const { pipelineId } = await params;
  const [configuration, requestHeaders] = await Promise.all([
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" })) return null;
        return getPipelineBuilderConfiguration(client, { tenantId: ctx.tenant.id, pipelineId });
      },
    ),
    headers(),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  if (!configuration) redirect(tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/home" }));
  const connectHref = tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/admin/connect" });
  const saveAction = savePipelineConfigurationAction.bind(null, configuration.id);
  const isSalesforce = configuration.connectorType === "salesforce";

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href={connectHref} className="text-sm font-medium text-teal-deep hover:underline">← Back to Connect</Link>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Guided pipeline setup</p>
          <h1 className="mt-2 font-display text-3xl font-bold text-ink">{configuration.name}</h1>
          <p className="mt-2 text-sm text-muted">
            {configuration.connectorName} · {configuration.connectorType.replace("_", " ")} · {configuration.status}
          </p>
        </div>
        <div className="rounded-md border border-line bg-panel px-4 py-3 text-right">
          <div className="text-lg font-bold text-ink">v{configuration.versionNumber || "—"}</div>
          <div className="text-xs uppercase tracking-wide text-muted">saved configuration</div>
        </div>
      </div>

      <div className="mt-6 grid gap-2 sm:grid-cols-5">
        {["1 Source", "2 Fields", "3 Load", "4 Schedule", "5 Review"].map((step) => (
          <div key={step} className="rounded border border-line bg-panel px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted">{step}</div>
        ))}
      </div>

      <form action={saveAction} className="mt-6 space-y-6">
        <section className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-display text-lg font-semibold text-ink">1. Source and latest observation</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              Pipeline name
              <input name="name" required minLength={2} maxLength={100} defaultValue={configuration.name} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
            </label>
            <div className="rounded border border-line bg-white px-3 py-2 text-sm text-muted">
              <div><span className="font-medium text-ink">Last run:</span> {configuration.lastRunStatus ?? "No source observed yet"}</div>
              {configuration.lastRunAt && <div className="mt-1 text-xs">{new Date(configuration.lastRunAt).toLocaleString("en-GB")}</div>}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-display text-lg font-semibold text-ink">2. Choose and shape fields</h2>
          <p className="mt-1 text-sm text-muted">The latest successful source observation supplies this schema. Renames and types are applied before rows enter the governed dataset.</p>
          <input type="hidden" name="mappingCount" value={configuration.fieldMappings.length} />
          {configuration.fieldMappings.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-line">
                    <th className="px-2 py-2">Use</th><th className="px-2 py-2">Source field</th><th className="px-2 py-2">Dataset field</th><th className="px-2 py-2">Type</th><th className="px-2 py-2">Required</th>
                  </tr>
                </thead>
                <tbody>
                  {configuration.fieldMappings.map((mapping, position) => {
                    const lockedSalesforceField = isSalesforce && (mapping.sourceField === "Id" || mapping.sourceField === "IsDeleted");
                    return (
                    <tr key={mapping.sourceField} className="border-b border-line last:border-b-0">
                      <td className="px-2 py-3">
                        {lockedSalesforceField && <input type="hidden" name={`included:${position}`} value="on" />}
                        <input aria-label={`Include ${mapping.sourceField}`} type="checkbox" name={lockedSalesforceField ? undefined : `included:${position}`} defaultChecked={mapping.isIncluded} disabled={lockedSalesforceField} />
                      </td>
                      <td className="px-2 py-3 font-medium text-ink">
                        {mapping.sourceField}
                        <input type="hidden" name={`sourceField:${position}`} value={mapping.sourceField} />
                      </td>
                      <td className="px-2 py-3"><input name={`targetField:${position}`} required maxLength={200} defaultValue={mapping.targetField} readOnly={lockedSalesforceField} className="w-full rounded border border-line bg-white px-2 py-1.5 text-text read-only:bg-slate-50 read-only:text-muted" /></td>
                      <td className="px-2 py-3">
                        <select name={`dataType:${position}`} defaultValue={mapping.dataType} className="w-full rounded border border-line bg-white px-2 py-1.5 text-text">
                          {typeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-3"><input aria-label={`Require ${mapping.sourceField}`} type="checkbox" name={`required:${position}`} defaultChecked={mapping.isRequired} /></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-4 rounded border border-dashed border-line bg-white px-4 py-6 text-sm text-muted">
              Run this source once to discover its fields. You can save load and schedule settings now, then return to map the observed schema.
            </div>
          )}
        </section>

        <section className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-display text-lg font-semibold text-ink">3. Load and row checks</h2>
          {isSalesforce ? (
            <div className="mt-4 rounded border border-line bg-white px-4 py-3 text-sm text-muted">
              <input type="hidden" name="loadMode" value="upsert" />
              <input type="hidden" name="keyColumns" value="Id" />
              Salesforce uses an immutable <strong className="text-ink">Id upsert</strong>. New records are inserted, changed records are updated, and Salesforce deletions remain as tombstones for lineage rather than silently disappearing.
            </div>
          ) : <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              Load behaviour
              <select name="loadMode" defaultValue={configuration.loadMode} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                <option value="snapshot">Replace the current snapshot</option>
                <option value="append">Append each delivered row</option>
                <option value="upsert">Add new and update existing records</option>
              </select>
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              Dataset key fields
              <input name="keyColumns" defaultValue={configuration.keyColumns.join(", ")} placeholder="response_id" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              <span className="mt-1 block font-normal normal-case tracking-normal">Required for upsert. Use dataset field names, separated by commas.</span>
            </label>
          </div>}
          <p className="mt-4 rounded bg-white px-3 py-2 text-sm text-muted">Rows with missing required values, invalid configured types, missing keys or duplicate source keys are quarantined and counted in run health.</p>
        </section>

        <section className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-display text-lg font-semibold text-ink">4. Refresh schedule</h2>
          {configuration.connectorType === "sharepoint" || isSalesforce ? (
            <label className="mt-4 block max-w-sm text-xs font-semibold uppercase tracking-wide text-muted">
              {isSalesforce ? "Refresh Salesforce object" : "Check Microsoft for changes"}
              <select name="pollIntervalMinutes" defaultValue={String(configuration.pollIntervalMinutes ?? 60)} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                <option value="60">Every hour</option>
                <option value="180">Every 3 hours</option>
                <option value="360">Every 6 hours</option>
                <option value="720">Every 12 hours</option>
                <option value="1440">Daily</option>
              </select>
            </label>
          ) : (
            <p className="mt-3 text-sm text-muted">This delivery pipeline runs when an analyst uploads a new CSV/XLSX revision. Scheduled file collection is available through Microsoft workbooks or Custom ETL.</p>
          )}
        </section>

        <section className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-display text-lg font-semibold text-ink">5. Review and save</h2>
          <p className="mt-1 text-sm text-muted">Saving creates an immutable configuration version and audit event. The next run uses the new mapping and validation contract.</p>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-muted">
            Change note
            <input name="changeNote" maxLength={500} placeholder="Why this pipeline configuration changed" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
          </label>
          <button type="submit" className="mt-4 rounded bg-navy px-5 py-2.5 text-sm font-semibold text-white">Save pipeline configuration</button>
        </section>
      </form>
    </div>
  );
}
