import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { listConnectorOverview } from "@/server/domains/connectors/connectors";
import { createManualFilePipelineAction } from "./actions";

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

  const connectors = await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, (client) =>
    listConnectorOverview(client, { tenantId: ctx.tenant.id }),
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Hized Connect</p>
          <h1 className="mt-2 font-display text-3xl font-bold text-ink">Data pipelines</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Bring files and operational systems into one monitored, tenant-isolated ingestion path.
          </p>
        </div>
        <div className="rounded-md border border-line bg-panel px-4 py-3 text-right">
          <div className="text-2xl font-bold text-ink">{connectors.length}</div>
          <div className="text-xs uppercase tracking-wide text-muted">configured sources</div>
        </div>
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        {[
          ["Files", "CSV and Excel uploads; SharePoint revisions are next."],
          ["Salesforce", "SystemModstamp watermark with a 24-hour replay window."],
          ["Zendesk", "Cursor-based incremental tickets and service data."],
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
