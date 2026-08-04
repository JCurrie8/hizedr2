"use client";

import { useActionState, useState } from "react";
import {
  createPlatformAdminInviteAction,
  type PlatformAdminInviteState,
} from "../../actions";

const initialState: PlatformAdminInviteState = { inviteUrl: null, error: null };

export function CompanyAdminInviteForm({ tenantId, disabled }: { tenantId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(createPlatformAdminInviteAction, initialState);
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
      <h2 className="font-display text-lg font-semibold text-ink">Company Admin access</h2>
      <p className="mt-1 text-sm text-muted">
        Create a single-use Company Admin invitation for onboarding or access recovery. The raw link is shown once.
      </p>
      <form action={action} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <input type="hidden" name="tenantId" value={tenantId} />
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
          Administrator email
          <input
            name="email"
            type="email"
            required
            disabled={disabled}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={pending || disabled}
          className="rounded-md bg-teal px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create invite"}
        </button>
      </form>
      {disabled && <p className="mt-3 text-xs text-amber-800">Reactivate this tenant before creating invitations.</p>}
      {state.error && <p className="mt-3 text-sm text-danger">{state.error}</p>}
      {state.inviteUrl && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-teal/30 bg-teal/10 p-3 text-xs text-ink">
          <code className="min-w-0 flex-1 truncate">{state.inviteUrl}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(state.inviteUrl ?? "");
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="rounded bg-ink px-2 py-1 font-semibold text-white"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
