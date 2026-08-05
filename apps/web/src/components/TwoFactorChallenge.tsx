"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { postLoginDestination } from "./login-routing";

/**
 * Shown after a correct password when the account has TOTP enabled — Better
 * Auth signals this with `twoFactorRedirect` rather than completing the
 * sign-in. Backup codes are accepted here too, because an authenticator app
 * lost with the phone is the realistic lockout case and the codes are
 * useless if there's nowhere to type them.
 */
export function TwoFactorChallenge({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        const { error: verifyError } = useBackupCode
          ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code });
        setPending(false);
        if (verifyError) {
          setError(
            verifyError.message ??
              (useBackupCode ? "That backup code wasn't accepted." : "That code wasn't accepted."),
          );
          return;
        }
        router.push(postLoginDestination(window.location.hostname));
        router.refresh();
      }}
    >
      <div>
        <p className="text-sm font-semibold text-ink">Two-step verification</p>
        <p className="mt-1 text-sm text-muted">
          {useBackupCode
            ? "Enter one of the backup codes you saved when you set this up."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
      </div>
      <label className="flex flex-col gap-1 text-sm text-text">
        {useBackupCode ? "Backup code" : "6-digit code"}
        <input
          inputMode={useBackupCode ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          required
          value={code}
          onChange={(e) => setCode(e.target.value.trim())}
          className="rounded-md border border-line px-3 py-2 font-mono text-sm tracking-widest"
        />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? "Verifying…" : "Verify"}
      </button>
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-teal-deep hover:underline"
          onClick={() => {
            setUseBackupCode((v) => !v);
            setCode("");
            setError(null);
          }}
        >
          {useBackupCode ? "Use authenticator app instead" : "Use a backup code"}
        </button>
        <button type="button" className="text-muted hover:underline" onClick={onCancel}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}
