"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { acceptExistingInviteAction } from "@/app/invite/[token]/actions";

export function AcceptInviteForm({
  email,
  token,
  signedInEmail,
}: {
  email: string;
  token: string;
  signedInEmail: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (signedInEmail) {
    const emailMatches = signedInEmail.toLowerCase() === email.toLowerCase();
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">Signed in as {signedInEmail}.</p>
        {emailMatches ? (
          <form action={acceptExistingInviteAction.bind(null, token)}>
            <button type="submit" className="w-full rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white">
              Accept invite
            </button>
          </form>
        ) : (
          <p className="text-sm text-danger">Sign out and open this invitation as {email}.</p>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        const { error: signUpError } = await authClient.signUp.email({
          email,
          password,
          name,
          fetchOptions: { headers: { "x-invite-token": token } },
        });
        setPending(false);
        if (signUpError) {
          setError(signUpError.message ?? "Could not create your account.");
          return;
        }
        router.push("/organisations");
        router.refresh();
      }}
    >
      <label className="flex flex-col gap-1 text-sm text-text">
        Email
        <input value={email} disabled className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Your name
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-line px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Choose a password
        <input
          type="password"
          required
          minLength={8}
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
        {pending ? "Creating account…" : "Accept invite & create account"}
      </button>
    </form>
  );
}
