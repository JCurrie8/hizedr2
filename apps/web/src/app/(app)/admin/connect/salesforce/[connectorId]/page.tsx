import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";
import { authenticateSalesforce, describeSalesforceObject } from "@/server/domains/connectors/salesforce-api";
import { getSalesforceConnectorCredentials, listSalesforceConnectors } from "@/server/domains/connectors/salesforce-connectors";
import { createSalesforcePipelineAction } from "../../actions";

export default async function SalesforceSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectorId: string }>;
  searchParams: Promise<{ object?: string }>;
}) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin" && ctx.role !== "analyst") {
    return <div className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted">Salesforce pipeline setup is available to company admins and analysts.</div>;
  }
  const [{ connectorId }, query, requestHeaders] = await Promise.all([params, searchParams, headers()]);
  const data = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "connect" })) return null;
      const connectors = await listSalesforceConnectors(client, { tenantId: ctx.tenant.id });
      const connector = connectors.find((candidate) => candidate.id === connectorId);
      if (!connector) throw new Error("The Salesforce connection was not found.");
      const stored = query.object
        ? await getSalesforceConnectorCredentials(client, { tenantId: ctx.tenant.id, connectorId })
        : null;
      return { connector, stored };
    },
  );
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  if (!data) redirect(tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/home" }));
  const connectHref = tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path: "/admin/connect" });
  const description = query.object && data.stored
    ? await describeSalesforceObject(
        await authenticateSalesforce(data.stored.credentials),
        data.stored.apiVersion,
        query.object,
      )
    : null;
  const createAction = createSalesforcePipelineAction.bind(null, connectorId);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href={connectHref} className="text-sm font-medium text-teal-deep hover:underline">← Back to Connect</Link>
      <p className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Salesforce object setup</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink">{data.connector.name}</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Choose one object at a time. Hized discovers only objects and scalar fields the dedicated Salesforce integration user is permitted to query; the saved consumer secret is never returned to this page.
      </p>

      <section className="mt-6 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-display text-lg font-semibold text-ink">1. Choose a queryable object</h2>
        <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-72 flex-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Salesforce object
            <select name="object" required defaultValue={query.object ?? ""} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
              <option value="" disabled>Select an object</option>
              {data.connector.catalog.map((object) => (
                <option key={object.name} value={object.name}>{object.label} · {object.name}{object.custom ? " · custom" : ""}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-teal-deep px-4 py-2 text-sm font-semibold text-white">Discover fields</button>
        </form>
      </section>

      {description && (
        <form action={createAction} className="mt-6 space-y-6">
          <input type="hidden" name="objectName" value={description.name} />
          <section className="rounded-lg border border-line bg-panel p-5">
            <h2 className="font-display text-lg font-semibold text-ink">2. Select {description.label} fields</h2>
            <p className="mt-1 text-sm text-muted">
              Id, {description.modifiedField}{description.supportsDeleted ? " and IsDeleted" : ""} are included automatically. Select up to 250 fields; values are mapped into governed storage and schema changes remain visible in run history.
            </p>
            <div className="mt-4 grid max-h-[30rem] gap-2 overflow-y-auto rounded border border-line bg-white p-3 sm:grid-cols-2 lg:grid-cols-3">
              {description.fields.map((field, index) => {
                const required = field.name === "Id" || field.name === description.modifiedField || (description.supportsDeleted && field.name === "IsDeleted");
                return (
                  <label key={field.name} className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                    <input name="fields" type="checkbox" value={field.name} defaultChecked={required || (description.fields.length <= 250 && index < 250)} disabled={required} className="mt-1" />
                    {required && <input type="hidden" name="fields" value={field.name} />}
                    <span><strong className="font-medium text-ink">{field.label}</strong><span className="block font-mono text-xs text-muted">{field.name} · {field.salesforceType}</span></span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-line bg-panel p-5">
            <h2 className="font-display text-lg font-semibold text-ink">3. Bootstrap and refresh</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Pipeline name
                <input name="pipelineName" required minLength={2} maxLength={100} defaultValue={`${description.label} from Salesforce`} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Initial history
                <select name="initialHistory" defaultValue="full" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="full">Full available history</option>
                  <option value="1">Previous day</option>
                  <option value="7">Previous 7 days</option>
                  <option value="30">Previous 30 days</option>
                  <option value="365">Previous year</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted">
                Refresh
                <select name="pollIntervalMinutes" defaultValue="1440" className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
                  <option value="60">Every hour</option>
                  <option value="180">Every 3 hours</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                  <option value="1440">Daily</option>
                </select>
              </label>
            </div>
            <p className="mt-4 rounded bg-white px-3 py-2 text-sm text-muted">
              After the bootstrap, Hized rereads a rolling 24-hour overlap on every run and upserts by Salesforce Id. The checkpoint advances only after the complete object load commits.
            </p>
            <button type="submit" className="mt-4 rounded bg-navy px-5 py-2.5 text-sm font-semibold text-white">Create Salesforce pipeline</button>
          </section>
        </form>
      )}
    </div>
  );
}
