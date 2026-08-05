import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { mfaEnrolmentRedirect } from "@/server/domains/access-control/mfa-policy";
import { SignOutButton } from "@/components/SignOutButton";
import Link from "next/link";

export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });

  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "platform_admin") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md px-8 text-center">
          <h1 className="font-display text-2xl font-bold text-ink">Access denied</h1>
          <p className="mt-3 text-sm text-muted">Platform admin access only.</p>
        </div>
      </div>
    );
  }

  // Platform Admin is the most privileged access in Hized (blueprint 7.4),
  // so a second factor is required unconditionally — not role-dependent
  // like the tenant side.
  const mfaRedirect = mfaEnrolmentRedirect({
    scope: "platform_admin",
    twoFactorEnabled: ctx.twoFactorEnabled,
    pathname: (await headers()).get("x-pathname") ?? "",
  });
  if (mfaRedirect) redirect(mfaRedirect);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-ink">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <span className="font-display text-lg font-bold text-white">Hized — Platform Admin</span>
          <nav className="ml-auto flex items-center gap-4 text-sm text-mist">
            <Link href="/platform-admin" className="hover:text-white">Tenants</Link>
            <Link href="/platform-admin/audit" className="hover:text-white">Audit</Link>
            <Link href="/platform-admin/security" className="hover:text-white">Security</Link>
            <span>{ctx.fullName ?? "You"}</span>
            <SignOutButton />
          </nav>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
