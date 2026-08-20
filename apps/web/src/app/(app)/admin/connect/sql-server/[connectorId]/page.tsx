import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { describeSqlServerObject } from "@/server/domains/connectors/sql-server-api";
import { getSqlServerCredentials, listSqlServerConnectors } from "@/server/domains/connectors/sql-server-connectors";
import { createSqlServerPipelineAction } from "../../actions";

export default async function SqlServerSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectorId: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    return <div className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted">SQL Server pipeline setup is available to company admins and analysts.</div>;
  }
  const [{ connectorId }, query, requestHeaders] = await Promise.all([params, searchParams, headers()]);
  const data = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" })) return null;
      const connectors = await listSqlServerConnectors(client, { tenantId: ctx.tenant.id });
      const connector = connectors.find((candidate) => candidate.id === connectorId);
      if (!connector) throw new Error("The SQL Server connection was not found.");
      const sourceIndex = query.source === undefined ? null : Number(query.source);
      const source = sourceIndex !== null && Number.isInteger(sourceIndex) ? connector.catalog[sourceIndex] : null;
      const stored = source
        ? await getSqlServerCredentials(client, { tenantId: ctx.tenant.id, connectorId })
        : null;
      return { connector, source, stored };
    },
  );
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  if (!data) redirect(tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/home" }));
  const connectHref = tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/admin/connect" });
  const description = data.source && data.stored
    ? await describeSqlServerObject(data.stored.credentials, { schema: data.source.schema, object: data.source.name })
    : null;
  const createAction = createSqlServerPipelineAction.bind(null, connectorId);
  const supportedFields = description?.fields.filter((field) => field.supported) ?? [];
  const suggestedKeys = supportedFields.filter((field) => field.primaryKey);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href={connectHref} className="text-sm font-medium text-teal-deep hover:underline">← Back to Connect</Link>
      <p className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">SQL source setup</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink">{data.connector.name}</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Browse only the tables and views visible to the saved read-only login. Hized generates bounded SELECT statements; analysts never enter arbitrary SQL or see the stored password.
      </p>

      <section className="mt-6 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-display text-lg font-semibold text-ink">1. Choose a permitted table or view</h2>
        <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-72 flex-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Source object
            <select name="source" required defaultValue={query.source ?? ""} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
              <option value="" disabled>Select a table or view</option>
              {data.connector.catalog.map((object, index) => (
                <option key={`${object.schema}.${object.name}`} value={index}>{object.schema}.{object.name} · {object.objectType}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-teal-deep px-4 py-2 text-sm font-semibold text-white">Discover columns</button>
        </form>
      </section>

      {description && (
        <form action={createAction} className="mt-6 space-y-6">
          <input type="hidden" name="schema" value={description.schema} />
          <input type="hidden" name="object" value={description.name} />
          <section className="rounded-lg border border-line bg-panel p-5">
            <h2 className="font-display text-lg font-semibold text-ink">2. Select governed fields</h2>
            <p className="mt-1 text-sm text-muted">Unsupported SQL-specific values are excluded. Select up to 250 scalar fields; configure sensitive fields after publishing the resulting governed dataset.</p>
            <div className="mt-4 grid max-h-[30rem] gap-2 overflow-y-auto rounded border border-line bg-white p-3 sm:grid-cols-2 lg:grid-cols-3">
              {supportedFields.map((field) => (
                <label key={field.name} className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input name="fields" type="checkbox" value={field.name} defaultChecked className="mt-1" />
                  <span><strong className="font-medium text-ink">{field.name}</strong><span className="block font-mono text-xs text-muted">{field.sqlType} · {field.dataType}{field.primaryKey ? " · primary key" : ""}</span></span>
                </label>
              ))}
            </div>
            {description.fields.some((field) => !field.supported) && (
              <p className="mt-3 text-xs text-muted">Excluded: {description.fields.filter((field) => !field.supported).map((field) => `${field.name} (${field.sqlType})`).join(", ")}.</p>
            )}
          </section>

          <section className="rounded-lg border border-line bg-panel p-5">
            <h2 className="font-display text-lg font-semibold text-ink">3. Keys and refresh behaviour</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Pipeline name
                <input name="pipelineName" required minLength={2} maxLength={100} defaultValue={`${description.schema}.${description.name}`} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Load mode
                <select name="loadMode" defaultValue={suggestedKeys.length > 0 ? "upsert" : "snapshot"} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="snapshot">Replace guarded snapshot</option>
                  <option value="upsert">Upsert by stable key</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Watermark (optional)
                <select name="watermarkField" defaultValue="" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="">Full extraction</option>
                  {supportedFields.filter((field) => field.dataType === "date" || field.dataType === "timestamp").map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>
              </label>
              <fieldset className="rounded border border-line bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Stable upsert keys</legend>
                <div className="mt-1 grid max-h-32 gap-1 overflow-y-auto">
                  {supportedFields.map((field) => (
                    <label key={field.name} className="flex items-center gap-2 text-sm text-ink">
                      <input name="keyColumns" type="checkbox" value={field.name} defaultChecked={field.primaryKey} />
                      {field.name}{field.primaryKey ? " · source primary key" : ""}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className="mt-4 rounded bg-white px-3 py-2 text-sm text-muted">
              Incremental refresh requires a date/timestamp watermark and at least one stable key. Hized rereads a 24-hour overlap, upserts repeated rows, and advances the checkpoint only after the complete governed load commits. Full snapshots preserve the current dataset if a new extract is empty.
            </p>
            <p className="mt-2 text-xs text-muted">
              Watermarks cannot infer hard-deleted rows. Use a full snapshot, a source soft-delete/change-tracking field or Hized-managed Custom ETL when deletion fidelity matters.
            </p>
            <button type="submit" className="mt-4 rounded bg-navy px-5 py-2.5 text-sm font-semibold text-white">Create SQL pipeline</button>
          </section>
        </form>
      )}
    </div>
  );
}
