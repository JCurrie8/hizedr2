import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";

export default async function DashboardPage() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") return null; // layout already redirects/handles other cases

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">
        Secure shell — Phase 0
      </p>
      <h1 className="mt-2 font-display text-2xl font-bold text-ink">
        Welcome to {ctx.tenant.name}
      </h1>
      <p className="mt-3 max-w-lg text-sm text-muted">
        Signed in as {ctx.fullName ?? "you"}, role {ctx.role.replace("_", " ")}. Organisation
        hierarchy and dashboards land in the next phases — this confirms auth, tenant
        resolution and RLS are wired end to end.
      </p>
    </div>
  );
}
