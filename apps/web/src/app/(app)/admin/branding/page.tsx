import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { getDraftBranding, getPublishedBranding } from "@/server/domains/branding/branding";
import { BrandingForm } from "./BrandingForm";

export default async function BrandingPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null;
  if (ctx.role !== "company_admin") {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="font-display text-2xl font-bold text-ink">Branding</h1>
        <p className="mt-3 text-sm text-muted">Only a Company Admin can configure tenant branding.</p>
      </div>
    );
  }

  const { draft, published } = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => ({
      draft: await getDraftBranding(client, { tenantId: ctx.tenant.id }),
      published: await getPublishedBranding(client, { tenantId: ctx.tenant.id }),
    }),
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal-deep">Company setup</p>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-ink">Brand your Hized workspace</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Add your company identity without compromising readability or security. Preview privately, then publish one consistent theme to Pulse, Canvas and the tenant navigation.
      </p>
      <BrandingForm tenantName={ctx.tenant.name} draft={draft} published={published} />
    </div>
  );
}
