"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type Stage = "idle" | "confirming" | "done";

/**
 * TOTP enrolment. Better Auth's enable() returns the otpauth:// URI and a
 * set of backup codes, but does NOT mark the factor active until a code
 * from the authenticator is verified — so the flow is deliberately
 * three-stage (password → scan/verify → backup codes) rather than
 * pretending enrolment is complete the moment the QR is shown.
 */
export function TwoFactorSetup({ enrolled }: { enrolled: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (enrolled && stage !== "done") {
    return (
      <div className="rounded-md border border-line bg-panel p-5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-success" aria-hidden />
          <p className="text-sm font-semibold text-ink">Two-factor authentication is on</p>
        </div>
        <p className="mt-2 text-sm text-muted">
          You&apos;ll be asked for a code from your authenticator app each time you sign in.
        </p>
      </div>
    );
  }

  const secret = totpUri ? (new URL(totpUri).searchParams.get("secret") ?? null) : null;

  return (
    <div className="rounded-md border border-line bg-panel p-5">
      {stage === "idle" && (
        <form
          className="flex max-w-sm flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setPending(true);
            const { data, error: enableError } = await authClient.twoFactor.enable({ password });
            setPending(false);
            if (enableError || !data) {
              setError(enableError?.message ?? "Could not start setup. Check your password and try again.");
              return;
            }
            setTotpUri(data.totpURI);
            setBackupCodes(data.backupCodes ?? []);
            setPassword("");
            setStage("confirming");
          }}
        >
          <div>
            <p className="text-sm font-semibold text-ink">Set up two-factor authentication</p>
            <p className="mt-1 text-sm text-muted">
              Required for this role. Confirm your password to begin.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm text-text">
            Your password
            <input
              type="password"
              required
              autoComplete="current-password"
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
            {pending ? "Starting…" : "Begin setup"}
          </button>
        </form>
      )}

      {stage === "confirming" && (
        <form
          className="flex max-w-sm flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setPending(true);
            const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code });
            setPending(false);
            if (verifyError) {
              setError(verifyError.message ?? "That code wasn't accepted. Try the next one.");
              return;
            }
            setStage("done");
            router.refresh();
          }}
        >
          <div>
            <p className="text-sm font-semibold text-ink">Add Hized to your authenticator app</p>
            <p className="mt-1 text-sm text-muted">
              Enter this setup key in Google Authenticator, 1Password, Authy or similar, then type the
              6-digit code it shows.
            </p>
          </div>
          {secret && (
            <code className="block break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-ink">
              {secret}
            </code>
          )}
          <label className="flex flex-col gap-1 text-sm text-text">
            6-digit code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
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
            {pending ? "Verifying…" : "Verify and turn on"}
          </button>
        </form>
      )}

      {stage === "done" && (
        <div className="max-w-md">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-success" aria-hidden />
            <p className="text-sm font-semibold text-ink">Two-factor authentication is on</p>
          </div>
          {backupCodes.length > 0 && (
            <>
              <p className="mt-3 text-sm text-muted">
                Save these backup codes somewhere safe. Each one works once, and they are the only way
                back in if you lose your authenticator app. They will not be shown again.
              </p>
              <ul className="mt-3 grid grid-cols-2 gap-2">
                {backupCodes.map((backupCode) => (
                  <li
                    key={backupCode}
                    className="rounded border border-line bg-canvas px-3 py-2 text-center font-mono text-sm text-ink"
                  >
                    {backupCode}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
