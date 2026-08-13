import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { TwoFactorSetup } from "@/components/TwoFactorSetup";

export default async function PlatformAdminSecurityPage() {
  const ctx = await getAuthContextFromRequest({
    platformAdminRoute: true,
    allowUnenrolledMfa: true,
  });
  if (ctx.kind !== "platform_admin") return null; // layout already handles other cases

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Security</h1>
      <p className="mt-2 text-sm text-muted">
        Platform Admin reaches across every tenant, so a second factor is required — this is the most
        privileged access in Hized.
      </p>
      <div className="mt-6">
        <TwoFactorSetup enrolled={ctx.twoFactorEnabled} />
      </div>
    </div>
  );
}
