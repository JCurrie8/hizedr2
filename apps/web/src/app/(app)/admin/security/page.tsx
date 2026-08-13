import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { tenantRoleRequiresMfa } from "@/server/domains/access-control/mfa-policy";
import { TwoFactorSetup } from "@/components/TwoFactorSetup";

export default async function SecurityPage() {
  const ctx = await getAuthContextFromRequest({ allowUnenrolledMfa: true });
  if (ctx.kind !== "tenant") return null; // layout already handles other cases

  const required = tenantRoleRequiresMfa(ctx.role);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-ink">Security</h1>
      <p className="mt-2 text-sm text-muted">
        {required
          ? "Company Admins manage other people's access, so a second factor is required before you can continue."
          : "Two-factor authentication adds a second step when you sign in. It is optional for your role."}
      </p>
      <div className="mt-6">
        <TwoFactorSetup enrolled={ctx.twoFactorEnabled} />
      </div>
    </div>
  );
}
