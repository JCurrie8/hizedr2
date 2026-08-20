import { withUserContext } from "@hized/db";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { loadKpiValueRecordDrill } from "@/server/domains/analytics/record-projection";
import { hasProductAccess } from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatMeasure(
  value: number,
  unit: string,
  currencyCode: string | null,
  decimalPlaces: number,
): string {
  if (unit === "percentage") return `${value.toFixed(decimalPlaces)}%`;
  if (unit === "currency") {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currencyCode ?? "GBP",
      maximumFractionDigits: decimalPlaces,
    }).format(value);
  }
  return new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(value);
}

function formatCell(value: string | number | boolean | null, dataType: string, timezone: string): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(value);
  if (dataType === "date" || dataType === "timestamp") {
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
    if (!Number.isNaN(parsed.valueOf())) {
      return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        ...(dataType === "timestamp" ? { timeStyle: "short" as const } : {}),
        timeZone: timezone,
      }).format(parsed);
    }
  }
  return value;
}

export default async function RecordDrillThroughPage({
  params,
}: {
  params: Promise<{ valueId: string }>;
}) {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null; // the layout already handles other cases

  const { valueId } = await params;
  if (!UUID_PATTERN.test(valueId)) notFound();

  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });

  const drill = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      if (!await hasProductAccess(client, { tenantId: ctx.tenant.id, productKey: "pulse" })) return null;
      return loadKpiValueRecordDrill(client, {
        tenantId: ctx.tenant.id,
        valueId,
        actorUserId: ctx.profileId,
        ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
        userAgent: requestHeaders.get("user-agent") ?? undefined,
      });
    },
  );
  if (!drill) redirect(tenantHref("/dashboard"));

  const { value, fields, records, coverage } = drill;
  // The rule's record-date field is usually projected as well, which would
  // render the same date twice. If a projected date column already carries the
  // record date for every row, drop the dedicated column rather than the field.
  const recordDateIsProjected = records.length > 0 && fields.some((field) =>
    (field.dataType === "date" || field.dataType === "timestamp")
    && records.every((record) =>
      record.occurredAt !== null
      && String(record.values[field.key] ?? "").slice(0, 10) === record.occurredAt.slice(0, 10)));
  const periodLabel = `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value.periodStart}T00:00:00Z`))} – ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value.periodEnd}T00:00:00Z`))}`;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <Link href={tenantHref("/dashboard")} className="text-sm font-semibold text-teal-deep hover:underline">
        ← Back to Pulse
      </Link>

      <div className="mt-4">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Supporting records</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">{value.kpiName}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{value.kpiDefinition}</p>
      </div>

      <section aria-label="Aggregate under inspection" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Organisation", value.organisationName],
          ["Reporting period", periodLabel],
          ["Approved value", formatMeasure(value.actualValue, value.unit, value.currencyCode, value.decimalPlaces)],
          ["Linked records", coverage.linkedRecords.toLocaleString("en-GB")],
        ].map(([label, content]) => (
          <article key={label} className="rounded-xl border border-line bg-panel p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
            <p className="mt-2 font-display text-lg font-semibold text-ink">{content}</p>
          </article>
        ))}
      </section>

      <section className="mt-5 rounded-xl border border-line bg-panel p-4 sm:p-5">
        <h2 className="font-display text-lg font-semibold text-ink">What these records are</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          These are governed projections of the source records that fall inside this organisation and reporting period —
          approved, non-sensitive fields only. Connect&rsquo;s raw curated storage is never opened here, and this view was
          recorded in the tenant audit log.
        </p>
        {coverage.contributionTotal !== null && (
          <p className={`mt-3 rounded-lg border p-3 text-sm leading-6 ${coverage.explainsAggregate ? "border-line bg-canvas text-muted" : "border-warning/40 bg-amber-50 text-ink"}`}>
            {coverage.explainsAggregate
              ? `The linked records account for the full approved value (${formatMeasure(coverage.contributionTotal, value.unit, value.currencyCode, value.decimalPlaces)}).`
              : `The linked records total ${formatMeasure(coverage.contributionTotal, value.unit, value.currencyCode, value.decimalPlaces)}, which does not equal the approved value. Treat them as supporting detail, not a recalculation of the KPI.`}
          </p>
        )}
        {coverage.returnedRecords < coverage.linkedRecords && (
          <p className="mt-3 text-xs leading-5 text-muted">
            Showing the {coverage.returnedRecords.toLocaleString("en-GB")} most recent of {coverage.linkedRecords.toLocaleString("en-GB")} linked records.
          </p>
        )}
      </section>

      {records.length > 0 ? (
        <section className="mt-5 overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[640px] text-left text-xs">
            <caption className="sr-only">Governed records contributing to {value.kpiName} for {value.organisationName}</caption>
            <thead>
              <tr className="border-b border-line bg-canvas uppercase tracking-wide text-muted">
                {!recordDateIsProjected && <th className="px-3 py-2.5">Record date</th>}
                {fields.map((field) => <th key={field.key} className="px-3 py-2.5">{field.name}</th>)}
                <th className="px-3 py-2.5 text-right">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.projectionId} className="border-b border-line/70 last:border-0">
                  {!recordDateIsProjected && (
                    <th scope="row" className="px-3 py-2.5 font-medium text-ink">
                      {record.occurredAt
                        ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: ctx.tenant.timezone }).format(new Date(record.occurredAt))
                        : "—"}
                    </th>
                  )}
                  {fields.map((field, index) => (
                    <td key={field.key} className="px-3 py-2.5 text-muted">
                      {index === 0 && recordDateIsProjected
                        ? <span className="font-medium text-ink">{formatCell(record.values[field.key] ?? null, field.dataType, ctx.tenant.timezone)}</span>
                        : formatCell(record.values[field.key] ?? null, field.dataType, ctx.tenant.timezone)}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-right font-semibold text-ink">
                    {record.contributionValue === null
                      ? "—"
                      : formatMeasure(record.contributionValue, value.unit, value.currencyCode, value.decimalPlaces)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="mt-5 rounded-xl border border-dashed border-line bg-panel p-6">
          <h2 className="font-display text-lg font-semibold text-ink">No supporting records are available to you</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Either no governed record projection is published for this measure, or the contributing records sit outside your
            permitted organisation scope. Pulse never substitutes records you are not entitled to see.
          </p>
        </section>
      )}
    </div>
  );
}
