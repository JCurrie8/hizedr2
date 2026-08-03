"use client";

import { useActionState, useState } from "react";
import type { AppRole } from "@hized/contracts";
import type { MembershipAccess } from "@/server/domains/access-control/membership-access";
import { updateMemberAccessAction, type MemberAccessFormState } from "./actions";
import type { OrgScopeOption } from "./InviteForm";

const ROLES: { value: AppRole; label: string }[] = [
  { value: "company_admin", label: "Company Admin" },
  { value: "executive", label: "Executive" },
  { value: "functional_leader", label: "Functional Leader" },
  { value: "manager", label: "Manager" },
  { value: "employee", label: "End user" },
  { value: "analyst", label: "Analyst" },
];

const initialState: MemberAccessFormState = { saved: false, error: null };

export function MemberAccessForm({ member, orgScopes }: { member: MembershipAccess; orgScopes: OrgScopeOption[] }) {
  const [state, formAction, pending] = useActionState(updateMemberAccessAction, initialState);
  const [role, setRole] = useState<AppRole>(member.role);

  return (
    <form action={formAction} className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1.5fr)_1fr_1.5fr_0.8fr_auto] lg:items-end">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-text">{member.fullName ?? "Name not provided"}</p>
        <p className="truncate text-xs text-muted">{member.email}</p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Role
        <select
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value as AppRole)}
          className="rounded border border-line px-2 py-2 text-sm"
        >
          {ROLES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Primary scope
        <select
          name="orgNodeId"
          required={role !== "company_admin"}
          disabled={role === "company_admin"}
          defaultValue={member.primaryScope?.orgNodeId ?? ""}
          className="rounded border border-line px-2 py-2 text-sm disabled:bg-canvas disabled:text-muted"
        >
          <option value="">{role === "company_admin" ? "Whole company (automatic)" : "Choose a scope"}</option>
          {orgScopes.map((scope) => (
            <option key={scope.orgNodeId} value={scope.orgNodeId}>
              {`${"— ".repeat(scope.depth)}${scope.name} (${scope.nodeType})`}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Status
        <select name="status" defaultValue={member.status} className="rounded border border-line px-2 py-2 text-sm">
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </label>

      <button type="submit" disabled={pending} className="rounded bg-navy px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? "Saving…" : "Save"}
      </button>

      {(state.error || state.saved) && (
        <p className={`text-xs sm:col-span-2 lg:col-span-5 ${state.error ? "text-danger" : "text-teal-deep"}`}>
          {state.error ?? "Access saved."}
        </p>
      )}
    </form>
  );
}

export function MemberAccessList({ members, orgScopes }: { members: MembershipAccess[]; orgScopes: OrgScopeOption[] }) {
  return (
    <div className="mt-2 divide-y divide-line rounded-md border border-line bg-white">
      {members.map((member) => (
        <MemberAccessForm key={member.membershipId} member={member} orgScopes={orgScopes} />
      ))}
      {members.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No members yet.</p> : null}
    </div>
  );
}
