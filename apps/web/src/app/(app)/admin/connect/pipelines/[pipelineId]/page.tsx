import Link from "next/link";
import { headers } from "next/headers";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { getPipelineBuilderConfiguration } from "@/server/domains/connectors/pipeline-configuration";
import { getPipelineSqlDestination, listSqlServerDestinations } from "@/server/domains/connectors/sql-server-destinations";
import { listPipelineSqlTransformationVersions } from "@/server/domains/connectors/sql-server-transformations";
import { listSqlServerConnectors } from "@/server/domains/connectors/sql-server-connectors";
import { listSqlPublicationsForWorkbenchPipeline } from "@/server/domains/connectors/sql-server-publications";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { redirect } from "next/navigation";
import { savePipelineConfigurationAction } from "./actions";
import {
  approveSqlTransformationVersionAction,
  configurePipelineSqlDestinationAction,
  createApprovedSqlPublicationAction,
  registerSqlTransformationVersionAction,
  syncApprovedSqlPublicationAction,
  syncPipelineToSqlDestinationAction,
} from "../../actions";

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
  const [pipelineData, requestHeaders] = await Promise.all([
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => {
        if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" })) return null;
        const pulseEnabled = await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" });
        const [configuration, sqlDestinations, sqlDestination, sqlTransformations, sqlSourceConnectors, sqlPublications] = await Promise.all([
          getPipelineBuilderConfiguration(client, { tenantId: ctx.tenant.id, pipelineId }),
          listSqlServerDestinations(client, { tenantId: ctx.tenant.id }),
          getPipelineSqlDestination(client, { tenantId: ctx.tenant.id, pipelineId }),
          listPipelineSqlTransformationVersions(client, { tenantId: ctx.tenant.id, pipelineId }),
          listSqlServerConnectors(client, { tenantId: ctx.tenant.id }),
          listSqlPublicationsForWorkbenchPipeline(client, { tenantId: ctx.tenant.id, workbenchPipelineId: pipelineId }),
        ]);
        return { configuration, sqlDestinations, sqlDestination, sqlTransformations, sqlSourceConnectors, sqlPublications, pulseEnabled };
      },
    ),
    headers(),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  if (!pipelineData) redirect(tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/home" }));
  const { configuration, sqlDestinations, sqlDestination, sqlTransformations, sqlSourceConnectors, sqlPublications, pulseEnabled } = pipelineData;
  const connectHref = tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/admin/connect" });
  const saveAction = savePipelineConfigurationAction.bind(null, configuration.id);
  const isSalesforce = configuration.connectorType === "salesforce";
  const canLoadSqlWorkbench = configuration.connectorType !== "sql_server" && configuration.connectorType !== "azure_sql";
  const configureDestinationAction = configurePipelineSqlDestinationAction.bind(null, configuration.id);
  const suggestedTarget = configuration.name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "source_data";
  const sourceObserved = Boolean(configuration.lastRunStatus);
  const sourceValidated = configuration.lastRunStatus === "succeeded" || configuration.lastRunStatus === "warning";
  const sqlLoaded = sqlDestination?.lastLoadStatus === "succeeded";
  const approvedTransformation = sqlTransformations.find((version) => version.status === "approved") ?? null;
  const latestDraft = sqlTransformations.find((version) => version.status === "draft") ?? null;
  const registerTransformationAction = registerSqlTransformationVersionAction.bind(null, configuration.id);
  const approveTransformationAction = approveSqlTransformationVersionAction.bind(null, configuration.id);
  const createPublicationAction = createApprovedSqlPublicationAction.bind(null, configuration.id);
  const syncPublicationAction = syncApprovedSqlPublicationAction.bind(null, configuration.id);
  const currentPublication = approvedTransformation
    ? sqlPublications.find((publication) => publication.transformationId === approvedTransformation.id) ?? null
    : null;
  const publicationSucceeded = currentPublication?.lastRunStatus === "succeeded" || currentPublication?.lastRunStatus === "warning";
  const governedDatasetHref = currentPublication
    ? tenantAppUrl({
      slug: ctx.tenant.slug,
      host,
      protocol,
      path: `/admin/datasets?pipelineId=${encodeURIComponent(currentPublication.pipelineId)}#${currentPublication.publishedDatasetId ? `dataset-${currentPublication.publishedDatasetId}` : `publish-${currentPublication.pipelineId}`}`,
    })
    : null;

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

      {canLoadSqlWorkbench && (
        <section className="mt-6 rounded-lg border border-line bg-panel p-5">
          <p className="font-mono text-xs uppercase tracking-wide text-teal-deep">End-to-end stage status</p>
          <h2 className="mt-2 font-display text-lg font-semibold text-ink">Source to governed Hized publication</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-5">
            {[
              ["1", "Observed", sourceObserved ? configuration.lastRunStatus ?? "Observed" : "Waiting for source"],
              ["2", "Validated", sourceValidated ? (configuration.lastRunStatus === "warning" ? "Passed with warnings" : "Passed") : "Waiting"],
              ["3", "SQL loaded", sqlLoaded ? `${sqlDestination?.lastRowsWritten ?? 0} rows` : (sqlDestination?.lastLoadStatus ?? "Not loaded")],
              ["4", "Transformed / ready", approvedTransformation
                ? `${approvedTransformation.objectSchema}.${approvedTransformation.objectName} · v${approvedTransformation.versionNumber} approved`
                : latestDraft
                  ? `v${latestDraft.versionNumber} awaiting approval`
                  : "Not promoted yet"],
              ["5", "Hized published", currentPublication?.lastRunStatus === "succeeded" || currentPublication?.lastRunStatus === "warning"
                ? `${currentPublication.lastRowsAccepted ?? 0} rows · v${currentPublication.transformationVersion}`
                : currentPublication
                  ? (currentPublication.lastRunStatus ?? "Configured, not run")
                  : "Separate read-only pipeline"],
            ].map(([number, label, status]) => (
              <div key={number} className="rounded border border-line bg-white px-3 py-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Stage {number}</div>
                <div className="mt-1 text-sm font-semibold text-ink">{label}</div>
                <div className="mt-1 text-xs text-muted">{status}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">Stage 4 requires live SQL metadata validation and Company Admin promotion. Stage 5 remains separate so Hized can publish through a read-only connection without retaining loader permissions.</p>
        </section>
      )}

      {canLoadSqlWorkbench && (
        <section className="mt-6 rounded-lg border border-teal-deep bg-teal-50 p-5">
          <p className="font-mono text-xs uppercase tracking-wide text-teal-deep">SQL workbench stage</p>
          <h2 className="mt-2 font-display text-lg font-semibold text-ink">Load validated rows into SQL</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            This sends the current accepted source state into one Hized-managed landing/staging table. Clean and model it in SQL, then publish an approved table or view back into Hized using a separate read-only SQL connection.
          </p>

          {sqlDestinations.length > 0 ? (
            <form action={configureDestinationAction} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[2fr_2fr_1.4fr_auto] xl:items-end">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                SQL destination
                <select name="connectorId" required defaultValue={sqlDestination?.connectorId ?? ""} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="" disabled>Choose a workbench</option>
                  {sqlDestinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>{destination.name} · {destination.database}.{destination.managedSchema}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Landing table
                <input name="targetTable" required pattern="[A-Za-z_][A-Za-z0-9_]{0,127}" defaultValue={sqlDestination?.targetTable ?? suggestedTarget} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Deliver accepted rows
                <select name="scheduleIntervalMinutes" defaultValue={sqlDestination?.scheduleEnabled ? String(sqlDestination.scheduleIntervalMinutes) : "manual"} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="manual">Manually only</option>
                  <option value="60">Every hour</option>
                  <option value="180">Every 3 hours</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                  <option value="1440">Daily</option>
                </select>
              </label>
              <button type="submit" className="rounded border border-teal-deep bg-white px-4 py-2 text-sm font-semibold text-teal-deep">{sqlDestination ? "Update target" : "Configure target"}</button>
            </form>
          ) : (
            <p className="mt-4 rounded border border-dashed border-teal-200 bg-white px-4 py-3 text-sm text-muted">A Company Admin must add the schema-scoped SQL workbench destination on the Connect page first.</p>
          )}

          {sqlDestination && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-teal-200 bg-white px-4 py-3">
              <div className="text-sm text-muted">
                <div><strong className="font-medium text-ink">{sqlDestination.connectorName}</strong> · {sqlDestination.targetSchema}.{sqlDestination.targetTable}</div>
                <div className="mt-1 text-xs">{sqlDestination.lastLoadStatus ? `${sqlDestination.lastLoadStatus}${sqlDestination.lastRowsWritten === null ? "" : ` · ${sqlDestination.lastRowsWritten} rows`}` : "Not loaded yet"}{sqlDestination.lastLoadAt ? ` · ${new Date(sqlDestination.lastLoadAt).toLocaleString("en-GB")}` : ""}</div>
                <div className="mt-1 text-xs">
                  {sqlDestination.scheduleEnabled
                    ? `Automatic delivery every ${sqlDestination.scheduleIntervalMinutes === 1440 ? "day" : `${sqlDestination.scheduleIntervalMinutes / 60} hour${sqlDestination.scheduleIntervalMinutes === 60 ? "" : "s"}`}${sqlDestination.nextLoadAt ? ` · next check ${new Date(sqlDestination.nextLoadAt).toLocaleString("en-GB")}` : ""}`
                    : "Automatic delivery is off"}
                </div>
                {sqlDestination.nextRetryAt && <div className="mt-1 text-xs text-amber-700">Retry due {new Date(sqlDestination.nextRetryAt).toLocaleString("en-GB")} after {sqlDestination.consecutiveFailures} failed attempt{sqlDestination.consecutiveFailures === 1 ? "" : "s"}.</div>}
                {sqlDestination.lastMessage && <div className="mt-1 text-xs">{sqlDestination.lastMessage}</div>}
                {sqlDestination.lastError && <div className="mt-1 text-xs text-red-700">{sqlDestination.lastError}</div>}
              </div>
              <form action={syncPipelineToSqlDestinationAction}>
                <input type="hidden" name="pipelineId" value={configuration.id} />
                <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Load current rows to SQL</button>
              </form>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">Automatic delivery claims only a new successful source revision and retries failures with bounded backoff. Every delivery remains an atomic guarded snapshot: empty data, ownership mismatch or schema drift preserves the previous SQL target. Incremental destination upsert remains a later optimisation.</p>
        </section>
      )}

      {canLoadSqlWorkbench && sqlDestination && (
        <section className="mt-6 rounded-lg border border-line bg-panel p-5">
          <p className="font-mono text-xs uppercase tracking-wide text-teal-deep">Transformation approval</p>
          <h2 className="mt-2 font-display text-lg font-semibold text-ink">Promote a SQL table or view as ready</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Build and test the transformation in your normal SQL tooling. Hized validates the live object and its fields, records an immutable version, then requires a Company Admin to approve it. This screen does not execute arbitrary SQL.
          </p>

          {sqlLoaded ? (
            <form action={registerTransformationAction} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.3fr_1.7fr_2.4fr_auto] xl:items-end">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Managed schema
                <input name="objectSchema" required readOnly value={sqlDestination.targetSchema} className="mt-1 block w-full rounded border border-line bg-slate-50 px-3 py-2 text-sm font-normal normal-case tracking-normal text-muted" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Transformed table or view
                <input name="objectName" required pattern="[A-Za-z_][A-Za-z0-9_]{0,127}" placeholder="daily_operations_ready" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Version note
                <input name="changeNote" required minLength={1} maxLength={500} placeholder="Cleaned account keys and standardised revenue" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              </label>
              <button type="submit" className="rounded border border-teal-deep bg-white px-4 py-2 text-sm font-semibold text-teal-deep">Validate and register</button>
            </form>
          ) : (
            <p className="mt-4 rounded border border-dashed border-line bg-white px-4 py-3 text-sm text-muted">Complete a successful SQL landing load before registering a transformed object.</p>
          )}

          {sqlTransformations.length > 0 && (
            <div className="mt-5 overflow-x-auto rounded border border-line bg-white">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-line"><th className="px-3 py-2">Version</th><th className="px-3 py-2">SQL object</th><th className="px-3 py-2">Validation</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Approval</th></tr>
                </thead>
                <tbody>
                  {sqlTransformations.map((version) => (
                    <tr key={version.id} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-3 font-semibold text-ink">v{version.versionNumber}</td>
                      <td className="px-3 py-3"><div className="font-medium text-ink">{version.objectSchema}.{version.objectName}</div><div className="mt-1 text-xs text-muted">{version.objectType} · {version.columnSignature.length} fields · {version.changeNote}</div></td>
                      <td className="px-3 py-3 text-xs text-muted">{new Date(version.validatedAt).toLocaleString("en-GB")}</td>
                      <td className="px-3 py-3 text-xs font-semibold uppercase tracking-wide text-muted">{version.status}</td>
                      <td className="px-3 py-3">
                        {version.status === "draft" && ctx.role === "company_admin" ? (
                          <form action={approveTransformationAction}>
                            <input type="hidden" name="transformationId" value={version.id} />
                            <button type="submit" className="rounded bg-navy px-3 py-2 text-xs font-semibold text-white">Recheck and approve</button>
                          </form>
                        ) : version.status === "draft" ? (
                          <span className="text-xs text-muted">Company Admin required</span>
                        ) : (
                          <span className="text-xs text-muted">{version.approvedAt ? new Date(version.approvedAt).toLocaleString("en-GB") : "—"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canLoadSqlWorkbench && approvedTransformation && (
        <section className="mt-6 rounded-lg border border-navy bg-slate-50 p-5">
          <p className="font-mono text-xs uppercase tracking-wide text-teal-deep">Governed Hized publication</p>
          <h2 className="mt-2 font-display text-lg font-semibold text-ink">Publish the approved SQL output into Hized</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Stage 5 uses a separate read-only SQL connection to the same database. Hized rechecks the approved object and imports its full supported field set as a guarded snapshot; the workbench loader credential is never reused.
          </p>

          {!currentPublication && sqlSourceConnectors.length > 0 && (
            <form action={createPublicationAction} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[2fr_2fr_1.5fr_auto] xl:items-end">
              <input type="hidden" name="transformationId" value={approvedTransformation.id} />
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Read-only SQL connection
                <select name="connectorId" required defaultValue="" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="" disabled>Choose a publisher</option>
                  {sqlSourceConnectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name} · {connector.database}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Hized pipeline name
                <input name="pipelineName" required minLength={2} maxLength={100} defaultValue={`${configuration.name} · approved SQL`} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Refresh Hized
                <select name="scheduleIntervalMinutes" defaultValue="manual" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="manual">Manually only</option><option value="60">Every hour</option><option value="180">Every 3 hours</option><option value="360">Every 6 hours</option><option value="720">Every 12 hours</option><option value="1440">Daily</option>
                </select>
              </label>
              <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Configure publication</button>
            </form>
          )}
          {!currentPublication && sqlSourceConnectors.length === 0 && (
            <p className="mt-4 rounded border border-dashed border-line bg-white px-4 py-3 text-sm text-muted">Add a separate read-only SQL Server/Azure SQL connection on the Connect page before publishing this approved object.</p>
          )}
          {currentPublication && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-white px-4 py-3">
                <div className="text-sm text-muted">
                  <div><strong className="font-medium text-ink">{currentPublication.pipelineName}</strong> · {currentPublication.connectorName}</div>
                  <div className="mt-1 text-xs">{currentPublication.objectSchema}.{currentPublication.objectName} · transformation v{currentPublication.transformationVersion}</div>
                  <div className="mt-1 text-xs">{currentPublication.lastRunStatus ? `${currentPublication.lastRunStatus}${currentPublication.lastRowsAccepted === null ? "" : ` · ${currentPublication.lastRowsAccepted} rows`}` : "Not published yet"}{currentPublication.lastRunAt ? ` · ${new Date(currentPublication.lastRunAt).toLocaleString("en-GB")}` : ""}</div>
                  <div className="mt-1 text-xs">{currentPublication.scheduleEnabled ? `Automatic snapshot every ${currentPublication.scheduleIntervalMinutes === 1440 ? "day" : `${currentPublication.scheduleIntervalMinutes / 60} hour${currentPublication.scheduleIntervalMinutes === 60 ? "" : "s"}`}` : "Automatic publication is off"}</div>
                  {currentPublication.lastError && <div className="mt-1 text-xs text-red-700">{currentPublication.lastError}</div>}
                </div>
                <form action={syncPublicationAction}>
                  <input type="hidden" name="publicationId" value={currentPublication.id} />
                  <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Publish to Hized now</button>
                </form>
              </div>
              {publicationSucceeded && pulseEnabled && governedDatasetHref && (
                <div className="mt-3 flex flex-col gap-3 rounded border border-teal-deep bg-teal-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm leading-6 text-ink">The SQL output is in Hized. Define its business name, field roles and sensitive-data boundary before Pulse or Canvas can use it.</p>
                  <Link href={governedDatasetHref} className="shrink-0 rounded bg-teal-deep px-4 py-2 text-center text-sm font-semibold text-white">{currentPublication.publishedDatasetId ? "Manage governed dataset" : "Create governed dataset"}</Link>
                </div>
              )}
              {publicationSucceeded && !pulseEnabled && (
                <p className="mt-3 rounded border border-line bg-white px-4 py-3 text-sm leading-6 text-muted">The approved SQL output is safely stored in Hized. Activate Pulse before publishing it as a governed analytical dataset.</p>
              )}
            </>
          )}
          {approvedTransformation && !currentPublication && sqlPublications.length > 0 && (
            <p className="mt-3 text-xs text-amber-700">The approved transformation changed. Configure a new publication for v{approvedTransformation.versionNumber}; the older pipeline remains recorded and is not silently repointed.</p>
          )}
        </section>
      )}
    </div>
  );
}
