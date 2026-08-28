"use client";

import { useActionState, useState } from "react";
import {
  createGatewayEnrollmentAction,
  type GatewayEnrollmentState,
} from "./actions";

const initialState: GatewayEnrollmentState = {
  enrollmentToken: null,
  expiresAt: null,
  error: null,
};

export function GatewayEnrollmentForm() {
  const [state, action, pending] = useActionState(createGatewayEnrollmentAction, initialState);
  const [copied, setCopied] = useState(false);

  return <div className="rounded-xl border border-line bg-panel p-5">
    <h2 className="font-display text-xl font-semibold text-ink">Enrol a Windows gateway</h2>
    <p className="mt-2 text-sm leading-6 text-muted">Create one short-lived token, then use it while installing the gateway on the private Windows host. The token is shown once and SQL credentials never enter Hized.</p>
    <form action={action} className="mt-5 grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium text-ink">Gateway name<input name="gatewayName" required minLength={2} maxLength={120} defaultValue="Activ8 Windows gateway" className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm" /></label>
      <label className="text-sm font-medium text-ink">Connection name<input name="connectorName" required minLength={2} maxLength={120} defaultValue="Activ8 SQL (private gateway)" className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm" /></label>
      <button disabled={pending} className="tenant-brand-primary w-fit rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60 sm:col-span-2">{pending ? "Creating…" : "Create 15-minute enrolment token"}</button>
    </form>
    {state.error && <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-danger">{state.error}</p>}
    {state.enrollmentToken && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-ink">Copy this token now</p>
      <p className="mt-1 text-xs text-muted">It expires {state.expiresAt ? new Date(state.expiresAt).toLocaleString("en-GB") : "in 15 minutes"} and cannot be recovered.</p>
      <div className="mt-3 flex items-center gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-xs">{state.enrollmentToken}</code><button type="button" onClick={async () => { await navigator.clipboard.writeText(state.enrollmentToken!); setCopied(true); setTimeout(() => setCopied(false), 2_000); }} className="rounded-md bg-navy px-3 py-2 text-xs font-semibold text-white">{copied ? "Copied" : "Copy"}</button></div>
      <p aria-live="polite" className="sr-only">{copied ? "Enrolment token copied." : ""}</p>
    </div>}
  </div>;
}
