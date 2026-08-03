import { withUserContext } from "@hized/db";
import Link from "next/link";
import { headers } from "next/headers";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import {
  listConnectorOverview,
  listManualFilePipelines,
  listRecentPipelineRuns,
} from "@/server/domains/connectors/connectors";
import { microsoftConnectorEnvironmentReady } from "@/server/domains/connectors/microsoft-oauth";
import { listMicrosoftConnectors } from "@/server/domains/connectors/sharepoint-connectors";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import {
  beginMicrosoftConnectionAction,
  configureMicrosoftWorkbookAction,
  createManualFilePipelineAction,
  syncMicrosoftWorkbookAction,
} from "./actions";
import { ManualUploadForm } from "./ManualUploadForm";

const connectorLabels: Record<string, string> = {
  file_upload: "CSV / Excel",
  sharepoint: "SharePoint / OneDrive",
  salesforce: "Salesforce",
  zendesk: "Zendesk",
};

export default async function ConnectPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  const canOperate = ctx.role === "company_admin" || ctx.role === "analyst";
  if (!canOperate) {
    return <div className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted">Connect is available to company admins and analysts.</div>;
  }

  const [requestHeaders, { connectors, filePipelines, microsoftConnectors, recentRuns }] = await Promise.all([
    headers(),
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      async (client) => ({
        connectors: await listConnectorOverview(client, { tenantId: ctx.tenant.id }),
        filePipelines: await listManualFilePipelines(client, { tenantId: ctx.tenant.id }),
        microsoftConnectors: await listMicrosoftConnectors(client, { tenantId: ctx.tenant.id }),
        recentRuns: await listRecentPipelineRuns(client, { tenantId: ctx.tenant.id }),
      }),
    ),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const pipelineHref = (pipelineId: string) => tenantAppUrl({
    slug: ctx.tenant.slug,
    host,
    protocol,
    path: `/admin/connect/pipelines/${pipelineId}`,
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Hized Connect</p>
          <h1 className="mt-2 font-display text-3xl font-bold text-ink">Data pipelines</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Add the files and operational systems your business already uses. Each source runs independently through one monitored, tenant-isolated ingestion path.
          </p>
        </div>
        <div className="rounded-md border border-line bg-panel px-4 py-3 text-right">
          <div className="text-2xl font-bold text-ink">{connectors.length}</div>
          <div className="text-xs uppercase tracking-wide text-muted">configured sources</div>
        </div>
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ["Files", "CSV/Excel uploads plus monitored SharePoint and OneDrive workbooks."],
          ["Business systems", "CRM, service, finance and workforce sources through reusable incremental adapters."],
          ["Databases & APIs", "Read-only SQL and common API pipelines selected around each customer's existing systems."],
          ["Custom ETL", "A paid, Hized-managed route for legacy systems, bespoke APIs and advanced transformation rules."],
        ].map(([title, description]) => (
          <div key={title} className="rounded-lg border border-line bg-panel p-4">
            <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
            <p className="mt-2 text-sm text-muted">{description}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-display text-lg font-semibold text-ink">Create a manual file pipeline</h2>
        <p className="mt-1 text-sm text-muted">Configure how repeated CSV/XLSX deliveries should load before uploading the first file.</p>
        <form action={createManualFilePipelineAction} className="mt-4 grid gap-3 md:grid-cols-[2fr_1fr_2fr_auto] md:items-end">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted">
            Pipeline name
            <input name="name" required minLength={2} maxLength={100} placeholder="Daily form responses" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
          </label>
          <label className="text-xs font-semibold uppercase tracking-wide text-muted">
            Load mode
            <select name="loadMode" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
              <option value="snapshot">Replace snapshot</option>
              <option value="append">Append</option>
              <option value="upsert">Upsert</option>
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-wide text-muted">
            Key columns for upsert
            <input name="keyColumns" placeholder="Response ID, Email" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
          </label>
          <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Create</button>
        </form>
      </section>

      <section className="mt-8 rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">SharePoint, OneDrive and Microsoft Forms</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Authorize a Microsoft work account, then monitor one CSV/XLSX workbook per connection. Forms response workbooks should use upsert with a stable response ID so repeated full-workbook reads do not duplicate responses.
            </p>
          </div>
          {!microsoftConnectorEnvironmentReady() && (
            <span className="rounded bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">Deployment setup required</span>
          )}
        </div>
        <form action={beginMicrosoftConnectionAction} className="mt-4 flex max-w-2xl flex-wrap items-end gap-3">
          <label className="min-w-64 flex-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Connection name
            <input name="name" required minLength={2} maxLength={100} placeholder="Operations Forms responses" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
          </label>
          <button disabled={!microsoftConnectorEnvironmentReady()} type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            Connect Microsoft
          </button>
        </form>

        {microsoftConnectors.length > 0 && (
          <div className="mt-6 space-y-4">
            {microsoftConnectors.map((connector) => (
              <div key={connector.id} className="rounded-md border border-line bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-ink">{connector.name}</h3>
                    <p className="mt-1 text-xs text-muted">{connector.connectedEmail ?? "Microsoft work account"}</p>
                  </div>
                  <span className="font-mono text-xs uppercase text-muted">{connector.status}</span>
                </div>

                {!connector.pipelineId ? (
                  <form action={configureMicrosoftWorkbookAction} className="mt-4 grid gap-3 md:grid-cols-2">
                    <input type="hidden" name="connectorId" value={connector.id} />
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Source
                      <select name="sourceKind" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                        <option value="sharepoint">SharePoint Online</option>
                        <option value="onedrive">OneDrive for Business</option>
                      </select>
                    </label>
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                      SharePoint site URL
                      <input name="siteUrl" type="url" placeholder="https://company.sharepoint.com/sites/Operations" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
                    </label>
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted md:col-span-2">
                      Workbook path
                      <input name="workbookPath" required placeholder="General/Forms/Operations survey.xlsx" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
                      <span className="mt-1 block font-normal normal-case tracking-normal">For SharePoint, enter the path relative to the site&apos;s default Documents library.</span>
                    </label>
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Pipeline name
                      <input name="pipelineName" required minLength={2} maxLength={100} defaultValue={connector.name} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
                    </label>
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Load mode
                      <select name="loadMode" defaultValue="upsert" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                        <option value="snapshot">Replace snapshot</option>
                        <option value="append">Append</option>
                        <option value="upsert">Upsert</option>
                      </select>
                    </label>
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted md:col-span-2">
                      Key columns for upsert
                      <input name="keyColumns" placeholder="Response ID" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
                    </label>
                    <div className="md:col-span-2">
                      <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Resolve and monitor workbook</button>
                    </div>
                  </form>
                ) : (
                  <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
                    <div className="text-sm text-muted">
                      <div><span className="font-medium text-ink">{connector.sourceName}</span> · {connector.loadMode}</div>
                      <div className="mt-1 break-all text-xs">{connector.sourcePath}</div>
                      {connector.lastSuccessAt && <div className="mt-1 text-xs">Last successful sync {new Date(connector.lastSuccessAt).toLocaleString("en-GB")}</div>}
                      {connector.lastError && <div className="mt-2 text-xs font-medium text-red-700">{connector.lastError}</div>}
                    </div>
                    <form action={syncMicrosoftWorkbookAction}>
                      <input type="hidden" name="pipelineId" value={connector.pipelineId} />
                      <div className="flex flex-wrap gap-2">
                        <Link href={pipelineHref(connector.pipelineId)} className="rounded border border-teal-deep px-4 py-2 text-sm font-semibold text-teal-deep">Configure pipeline</Link>
                        <button type="submit" className="rounded bg-teal-deep px-4 py-2 text-sm font-semibold text-white">Sync now</button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-display text-lg font-semibold text-ink">Upload and run</h2>
        <p className="mt-1 text-sm text-muted">
          Files go directly to private object storage, then Hized verifies their size and SHA-256 hash before parsing or loading rows.
        </p>
        {filePipelines.length > 0
          ? <>
              <ManualUploadForm pipelines={filePipelines.map(({ id, name, loadMode }) => ({ id, name, loadMode }))} />
              <div className="mt-4 flex flex-wrap gap-2">
                {filePipelines.map((pipeline) => (
                  <Link key={pipeline.id} href={pipelineHref(pipeline.id)} className="rounded border border-line bg-white px-3 py-2 text-sm font-medium text-teal-deep">
                    Configure {pipeline.name}
                  </Link>
                ))}
              </div>
            </>
          : <p className="mt-4 text-sm text-muted">Create a manual file pipeline before uploading a file.</p>}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Recent runs</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-panel">
          {recentRuns.map((run) => (
            <div key={run.id} className="grid gap-2 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[2fr_1fr_1fr_1fr] md:items-center">
              <div>
                <div className="font-medium text-ink">{run.pipelineName}</div>
                <time className="text-xs text-muted" dateTime={run.queuedAt}>{new Date(run.queuedAt).toLocaleString("en-GB")}</time>
              </div>
              <div className="font-mono text-xs uppercase text-muted">{run.status}</div>
              <div className="text-sm text-muted">{run.rowsAccepted} accepted</div>
              <div className="text-sm text-muted">{run.rowsRejected} quarantined</div>
            </div>
          ))}
          {recentRuns.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">No pipeline runs yet.</div>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Configured sources</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-panel">
          {connectors.map((connector) => (
            <div key={connector.id} className="grid gap-2 border-b border-line px-4 py-4 last:border-b-0 md:grid-cols-[2fr_1fr_1fr_1fr] md:items-center">
              <div>
                <div className="font-medium text-ink">{connector.name}</div>
                <div className="mt-1 text-xs text-muted">{connectorLabels[connector.connectorType] ?? connector.connectorType}</div>
              </div>
              <div className="text-sm text-muted">{connector.pipelineCount} pipeline{connector.pipelineCount === 1 ? "" : "s"}</div>
              <div className="font-mono text-xs uppercase text-muted">{connector.status}</div>
              <div className="text-sm text-muted">{connector.lastRunStatus ?? "No runs yet"}</div>
            </div>
          ))}
          {connectors.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">No sources configured yet.</div>}
        </div>
      </section>
    </div>
  );
}
