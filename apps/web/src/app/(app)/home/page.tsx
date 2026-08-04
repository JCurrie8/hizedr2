import { headers } from "next/headers";
import Link from "next/link";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import {
  entitlementStatus,
  listProductEntitlements,
  type ProductEntitlementStatus,
} from "@/server/domains/products/entitlements";
import { tenantAppUrl } from "@/server/domains/tenancy/tenant-landing";

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function ProductCard({
  eyebrow,
  title,
  description,
  status,
  href,
  roleMessage,
}: {
  eyebrow: string;
  title: string;
  description: string;
  status: ProductEntitlementStatus;
  href: string | null;
  roleMessage?: string;
}) {
  const included = status === "active" || status === "trial";
  return (
    <article className={`flex min-h-64 flex-col rounded-xl border bg-panel p-5 shadow-sm ${included ? "border-line" : "border-line/80"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-teal-deep">{eyebrow}</p>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
          included ? "bg-emerald-50 text-emerald-800" : "bg-canvas text-muted"
        }`}>
          {!included && <LockIcon />}
          {status === "trial" ? "Trial" : included ? "Included" : "Not included"}
        </span>
      </div>
      <h2 className="mt-5 font-display text-2xl font-bold text-ink">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
      <div className="mt-auto pt-6">
        {href ? (
          <Link href={href} className="tenant-brand-primary inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold">
            Open {title}
            <ArrowIcon />
          </Link>
        ) : included && roleMessage ? (
          <p className="text-sm font-medium text-muted">{roleMessage}</p>
        ) : (
          <a
            href="https://hized.com/#platform"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold text-teal-deep hover:underline"
          >
            Find out more
            <ArrowIcon />
          </a>
        )}
      </div>
    </article>
  );
}

export default async function ProductHomePage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;

  const [requestHeaders, entitlements] = await Promise.all([
    headers(),
    withUserContext(
      { userId: ctx.profileId, tenantId: ctx.tenant.id },
      (client) => listProductEntitlements(client, { tenantId: ctx.tenant.id }),
    ),
  ]);
  const host = requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const tenantHref = (path: string) => tenantAppUrl({ slug: ctx.tenant.slug, host, protocol, path });
  const canOperateConnect = ctx.role === "company_admin" || ctx.role === "analyst";
  const firstName = ctx.fullName?.trim().split(/\s+/)[0] ?? null;
  const pulseStatus = entitlementStatus(entitlements, "pulse");
  const connectStatus = entitlementStatus(entitlements, "connect");
  const canvasStatus = entitlementStatus(entitlements, "canvas");

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-deep">Hized Platform</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Welcome{firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
            Choose where you want to work in {ctx.tenant.name}. Your company&apos;s products and your role determine what is available.
          </p>
        </div>
        <Link href={tenantHref("/admin")} className="inline-flex items-center gap-2 self-start rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink hover:bg-canvas sm:self-auto">
          Settings
          <ArrowIcon />
        </Link>
      </div>

      <section aria-label="Products" className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ProductCard
          eyebrow="Governed performance"
          title="Pulse"
          description="See the KPIs, targets, trends and exceptions relevant to your role and organisation scope."
          status={pulseStatus}
          href={pulseStatus === "active" || pulseStatus === "trial" ? tenantHref("/dashboard") : null}
        />
        <ProductCard
          eyebrow="Data foundation"
          title="Connect"
          description="Bring spreadsheets, SharePoint, databases and business systems into monitored, reusable pipelines."
          status={connectStatus}
          href={(connectStatus === "active" || connectStatus === "trial") && canOperateConnect ? tenantHref("/admin/connect") : null}
          roleMessage="Included for your company. A Company Admin or Analyst configures pipelines."
        />
        <ProductCard
          eyebrow="Self-serve analysis"
          title="Canvas"
          description="Build your own boards from the same governed datasets and KPI definitions that power Pulse."
          status={canvasStatus}
          href={canvasStatus === "active" || canvasStatus === "trial" ? tenantHref("/canvas") : null}
        />
      </section>
    </div>
  );
}
