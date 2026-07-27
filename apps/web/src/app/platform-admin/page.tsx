import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";

export default async function PlatformAdminHome() {
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });
  if (ctx.kind !== "platform_admin") return null; // layout already handles other cases

  const tenants = await withUserContext({ userId: ctx.profileId }, (c) =>
    c.query("select id, slug, name, status from public.tenants order by name").then((r) => r.rows),
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-white">Tenants</h1>
      <ul className="mt-6 divide-y divide-white/10 rounded-lg border border-white/10">
        {tenants.map((t) => (
          <li key={t.id} className="flex items-center gap-4 px-4 py-3 text-sm text-mist">
            <span className="font-semibold text-white">{t.name}</span>
            <span className="font-mono text-xs">{t.slug}</span>
            <span className="ml-auto uppercase tracking-wide">{t.status}</span>
          </li>
        ))}
        {tenants.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-mist">No tenants yet.</li>
        )}
      </ul>
    </div>
  );
}
