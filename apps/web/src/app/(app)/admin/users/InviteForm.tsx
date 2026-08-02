"use client";

import { useActionState, useState } from "react";
import type { AppRole } from "@hized/contracts";
import { createInviteAction, type InviteFormState } from "./actions";

const ROLES: AppRole[] = ["company_admin", "executive", "functional_leader", "manager", "employee", "analyst"];

const initialState: InviteFormState = { inviteUrl: null, error: null };

export function InviteForm({ origin }: { origin: string }) {
  const [state, formAction, pending] = useActionState(createInviteAction, initialState);
  const [copied, setCopied] = useState(false);

  const fullUrl = state.inviteUrl ? `${origin}${state.inviteUrl}` : null;

  return (
    <div className="rounded-md border border-line p-4">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Email
          <input name="email" type="email" required className="rounded border border-line px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Role
          <select name="role" className="rounded border border-line px-2 py-1 text-sm">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-navy px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create invite"}
        </button>
      </form>

      {state.error && <p className="mt-3 text-sm text-danger">{state.error}</p>}

      {fullUrl && (
        <div className="mt-3 flex items-center gap-2 rounded bg-canvas p-2 text-xs">
          <code className="flex-1 truncate">{fullUrl}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(fullUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="rounded bg-navy px-2 py-1 font-semibold text-white"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
