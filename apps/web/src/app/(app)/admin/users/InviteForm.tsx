"use client";

import { useActionState, useState } from "react";
import type { AppRole, OrgNodeType } from "@hized/contracts";
import { createInviteAction, type InviteFormState } from "./actions";

const ROLES: AppRole[] = ["company_admin", "executive", "functional_leader", "manager", "employee", "analyst"];

const initialState: InviteFormState = { inviteUrl: null, error: null };

export interface OrgScopeOption {
  orgNodeId: string;
  nodeType: OrgNodeType;
  name: string;
  depth: number;
}

function roleLabel(role: AppRole): string {
  const labels: Record<AppRole, string> = {
    company_admin: "Company Admin",
    executive: "Executive",
    functional_leader: "Functional Leader",
    manager: "Manager",
    employee: "End user",
    analyst: "Analyst",
  };
  return labels[role];
}

export function InviteForm({ origin, orgScopes }: { origin: string; orgScopes: OrgScopeOption[] }) {
  const [state, formAction, pending] = useActionState(createInviteAction, initialState);
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState<AppRole>("employee");

  const fullUrl = state.inviteUrl ? `${origin}${state.inviteUrl}` : null;

  return (
    <div className="rounded-md border border-line p-4">
      <form action={formAction} className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Email
          <input name="email" type="email" required className="rounded border border-line px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Role
          <select
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value as AppRole)}
            className="rounded border border-line px-2 py-1 text-sm"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Organisation scope
          <select
            name="orgNodeId"
            required={role !== "company_admin"}
            disabled={role === "company_admin"}
            defaultValue=""
            className="rounded border border-line px-2 py-1 text-sm disabled:bg-canvas disabled:text-muted"
          >
            <option value="">{role === "company_admin" ? "Whole company (automatic)" : "Choose a scope"}</option>
            {orgScopes.map((scope) => (
              <option key={scope.orgNodeId} value={scope.orgNodeId}>
                {`${"— ".repeat(scope.depth)}${scope.name} (${scope.nodeType})`}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="self-end rounded bg-navy px-3 py-2 text-sm font-semibold text-white disabled:opacity-60 sm:col-span-2 sm:justify-self-start"
        >
          {pending ? "Creating…" : "Create invite"}
        </button>
      </form>

      <p className="mt-3 text-xs text-muted">
        Role controls what the user can do. Scope controls which company branch and records they can see.
      </p>

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
