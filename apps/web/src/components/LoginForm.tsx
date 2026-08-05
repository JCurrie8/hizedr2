"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { postLoginDestination } from "./login-routing";
import { TwoFactorChallenge } from "./TwoFactorChallenge";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);

  if (needsSecondFactor) {
    return (
      <TwoFactorChallenge
        onCancel={() => {
          setNeedsSecondFactor(false);
          setPassword("");
        }}
      />
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        const { data, error: signInError } = await authClient.signIn.email({ email, password });
        setPending(false);
        if (signInError) {
          setError(signInError.message ?? "Could not sign in.");
          return;
        }
        // The password was right but the account holds a second factor —
        // Better Auth has NOT issued a session yet, so routing on now would
        // just bounce off the auth gate.
        if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
          setNeedsSecondFactor(true);
          return;
        }
        router.push(postLoginDestination(window.location.hostname));
        router.refresh();
      }}
    >
      <label className="flex flex-col gap-1 text-sm text-text">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-line px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Password
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-line px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
