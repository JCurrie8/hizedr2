import {
  removeAnalyticsViewGrantAction,
  setAnalyticsViewGrantAction,
} from "@/app/(app)/analytics-actions";
import type {
  AnalyticsSharingOptions,
  AnalyticsViewGrant,
  AnalyticsViewStatus,
} from "@/server/domains/analytics/visual-views";

const inputClass = "mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink";

function AddGrantForm({
  viewId,
  type,
  label,
  options,
}: {
  viewId: string;
  type: "membership" | "role" | "org_node";
  label: string;
  options: Array<{ id: string; label: string; detail?: string }>;
}) {
  return (
    <form action={setAnalyticsViewGrantAction} className="rounded-lg border border-line bg-canvas p-4">
      <input type="hidden" name="viewId" value={viewId} />
      <input type="hidden" name="grantType" value={type} />
      <label className="text-sm font-medium text-ink">
        {label}
        <select className={inputClass} name="targetId" required defaultValue="">
          <option value="" disabled>Choose {label.toLowerCase()}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}{option.detail ? ` — ${option.detail}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-3 block text-sm font-medium text-ink">
        Permission
        <select className={inputClass} name="permission" defaultValue="view">
          <option value="view">Can view</option>
          <option value="edit">Can edit layout</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={options.length === 0}
        className="mt-4 rounded-md border border-line bg-panel px-3 py-2 text-sm font-semibold text-ink hover:border-teal-deep disabled:cursor-not-allowed disabled:opacity-50"
      >
        Add sharing rule
      </button>
    </form>
  );
}

export function AnalyticsSharingPanel({
  viewId,
  status,
  grants,
  options,
}: {
  viewId: string;
  status: AnalyticsViewStatus;
  grants: AnalyticsViewGrant[];
  options: AnalyticsSharingOptions;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-ink">Targeted sharing</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
            Share with specific people, company roles or organisation areas. This grants access to the board layout only; every viewer still sees KPI values through their own role, scope and data permissions.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status === "published" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
          {status === "published" ? "Live for recipients" : "Publish to make grants live"}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <AddGrantForm viewId={viewId} type="membership" label="Named person" options={options.members} />
        <AddGrantForm viewId={viewId} type="role" label="Company role" options={options.roles} />
        <AddGrantForm viewId={viewId} type="org_node" label="Organisation area" options={options.organisationNodes} />
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-ink">Current rules</h3>
        {grants.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{grant.label}</p>
                  <p className="mt-0.5 text-xs text-muted">{grant.detail} · {grant.type.replaceAll("_", " ")} · can {grant.permission}</p>
                </div>
                <form action={removeAnalyticsViewGrantAction}>
                  <input type="hidden" name="viewId" value={viewId} />
                  <input type="hidden" name="grantId" value={grant.id} />
                  <button type="submit" className="rounded-md border border-danger/30 px-3 py-1.5 text-xs font-semibold text-danger">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-line bg-canvas p-4 text-sm text-muted">
            No targeted sharing rules yet. Add a person, role or organisation area, then publish the board when it is ready for recipients.
          </p>
        )}
      </div>
    </section>
  );
}
