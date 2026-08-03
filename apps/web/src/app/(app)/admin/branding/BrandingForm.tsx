"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { BrandingTheme, BrandingTypography } from "@/server/domains/branding/branding";
import {
  prepareBrandLogoUploadAction,
  publishBrandingAction,
  resetBrandingAction,
  saveBrandingDraftAction,
} from "./actions";

const MAX_LOGO_BYTES = 1024 * 1024;

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function foreground(background: string): "#FFFFFF" | "#081B2C" {
  const channels = [1, 3, 5].map((index) => Number.parseInt(background.slice(index, index + 2), 16) / 255);
  const luminance = channels
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkLuminance = 0.0094;
  const darkContrast = (luminance + 0.05) / (darkLuminance + 0.05);
  return whiteContrast >= darkContrast ? "#FFFFFF" : "#081B2C";
}

const typographyLabels: Record<BrandingTypography, { name: string; description: string }> = {
  hized: { name: "Hized", description: "Inter body with Space Grotesk headings" },
  clean: { name: "Clean", description: "Inter throughout for a restrained interface" },
  geometric: { name: "Geometric", description: "Space Grotesk throughout for a stronger voice" },
};

export function BrandingForm({
  tenantName,
  draft,
  published,
}: {
  tenantName: string;
  draft: BrandingTheme;
  published: BrandingTheme;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [primaryColor, setPrimaryColor] = useState(draft.primaryColor);
  const [accentColor, setAccentColor] = useState(draft.accentColor);
  const [typography, setTypography] = useState<BrandingTypography>(draft.typography);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => () => {
    if (filePreview) URL.revokeObjectURL(filePreview);
  }, [filePreview]);

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setFilePreview(nextFile ? URL.createObjectURL(nextFile) : null);
    if (nextFile) setRemoveLogo(false);
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus(file ? "Validating and uploading logo…" : "Saving draft…");
    try {
      let logo: Parameters<typeof saveBrandingDraftAction>[0]["logo"];
      if (file) {
        if (!(file.type === "image/png" || file.type === "image/webp")) {
          throw new Error("Choose a PNG or WebP logo.");
        }
        if (file.size < 1 || file.size > MAX_LOGO_BYTES) throw new Error("Logo files must be no larger than 1 MB.");
        const contentSha256 = toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        const prepared = await prepareBrandLogoUploadAction({
          contentType: file.type,
          sizeBytes: file.size,
          contentSha256,
        });
        const response = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: prepared.uploadHeaders,
          body: file,
        });
        if (!response.ok) throw new Error(`Logo upload failed (${response.status}).`);
        logo = {
          storageKey: prepared.storageKey,
          contentType: file.type,
          sizeBytes: file.size,
          contentSha256,
        };
      }
      const result = await saveBrandingDraftAction({
        primaryColor,
        accentColor,
        typography,
        removeLogo,
        logo,
      });
      setStatus(result.message);
      chooseFile(null);
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save branding.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (busy) return;
    setBusy(true);
    setStatus("Publishing saved draft…");
    try {
      const result = await publishBrandingAction();
      setStatus(result.message);
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not publish branding.");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (busy || !window.confirm("Restore and publish the Hized logo, colours and typography defaults?")) return;
    setBusy(true);
    setStatus("Restoring Hized defaults…");
    try {
      const result = await resetBrandingAction();
      setStatus(result.message);
      chooseFile(null);
      setRemoveLogo(false);
      setPrimaryColor("#0F2A43");
      setAccentColor("#0E7C80");
      setTypography("hized");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reset branding.");
    } finally {
      setBusy(false);
    }
  }

  const draftLogoUrl = filePreview ?? (
    !removeLogo && draft.logoObjectKey
      ? `/api/branding/logo?draft=1&v=${encodeURIComponent(draft.changedAt ?? "draft")}`
      : null
  );
  const headingFont = typography === "clean" ? "var(--font-inter)" : "var(--font-space-grotesk)";
  const bodyFont = typography === "geometric" ? "var(--font-space-grotesk)" : "var(--font-inter)";

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
      <form onSubmit={saveDraft} className="rounded-xl border border-line bg-white p-5 shadow-sm sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Brand settings</h2>
          <p className="mt-1 text-sm text-muted">Changes remain private to Company Admins until you publish the saved draft.</p>
        </div>

        <div className="mt-6 grid gap-5">
          <label className="text-sm font-semibold text-ink">
            Company logo
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/webp,.png,.webp"
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              className="mt-2 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm font-normal text-text"
            />
            <span className="mt-1 block text-xs font-normal text-muted">Static PNG or WebP, up to 1 MB and 4096 × 4096 px.</span>
          </label>
          {(draft.logoObjectKey || file) && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={removeLogo}
                onChange={(event) => setRemoveLogo(event.target.checked)}
              />
              Remove the custom logo from this draft
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-ink">
              Primary colour
              <span className="mt-2 flex items-center gap-3 rounded-md border border-line bg-canvas p-2">
                <input
                  type="color"
                  aria-label="Primary colour picker"
                  value={/^#[0-9A-F]{6}$/.test(primaryColor) ? primaryColor : "#0F2A43"}
                  onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())}
                  className="h-9 w-12 cursor-pointer border-0 bg-transparent p-0"
                />
                <input
                  type="text"
                  aria-label="Primary colour hex"
                  value={primaryColor}
                  maxLength={7}
                  pattern="#[0-9A-Fa-f]{6}"
                  onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())}
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm font-normal text-text outline-none"
                />
              </span>
            </label>
            <label className="text-sm font-semibold text-ink">
              Accent colour
              <span className="mt-2 flex items-center gap-3 rounded-md border border-line bg-canvas p-2">
                <input
                  type="color"
                  aria-label="Accent colour picker"
                  value={/^#[0-9A-F]{6}$/.test(accentColor) ? accentColor : "#0E7C80"}
                  onChange={(event) => setAccentColor(event.target.value.toUpperCase())}
                  className="h-9 w-12 cursor-pointer border-0 bg-transparent p-0"
                />
                <input
                  type="text"
                  aria-label="Accent colour hex"
                  value={accentColor}
                  maxLength={7}
                  pattern="#[0-9A-Fa-f]{6}"
                  onChange={(event) => setAccentColor(event.target.value.toUpperCase())}
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm font-normal text-text outline-none"
                />
              </span>
            </label>
          </div>

          <fieldset>
            <legend className="text-sm font-semibold text-ink">Typography</legend>
            <div className="mt-2 grid gap-2">
              {(Object.keys(typographyLabels) as BrandingTypography[]).map((value) => (
                <label key={value} className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-[:checked]:border-navy has-[:checked]:bg-canvas">
                  <input
                    type="radio"
                    name="typography"
                    value={value}
                    checked={typography === value}
                    onChange={() => setTypography(value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{typographyLabels[value].name}</span>
                    <span className="block text-xs text-muted">{typographyLabels[value].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button disabled={busy} type="submit" className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Save draft
          </button>
          <button disabled={busy} type="button" onClick={publish} className="rounded-md border border-navy px-4 py-2 text-sm font-semibold text-navy disabled:opacity-50">
            Publish saved draft
          </button>
          <button disabled={busy} type="button" onClick={reset} className="rounded-md px-4 py-2 text-sm font-semibold text-danger hover:bg-red-50 disabled:opacity-50">
            Reset to Hized
          </button>
        </div>
        <p aria-live="polite" className="mt-3 min-h-5 text-sm text-muted">{status}</p>
      </form>

      <aside className="lg:sticky lg:top-32 lg:self-start">
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
          <div className="border-b border-line px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Private draft preview</p>
          </div>
          <div style={{ fontFamily: bodyFont }}>
            <div className="flex items-center gap-3 border-b border-line px-4 py-4">
              {draftLogoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated R2-backed route, not an optimisable public asset.
                <img src={draftLogoUrl} alt={`${tenantName} draft logo`} className="h-10 max-w-36 object-contain object-left" />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-md text-sm font-bold" style={{ backgroundColor: accentColor, color: foreground(accentColor) }}>
                  {tenantName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-lg font-bold text-ink" style={{ fontFamily: headingFont }}>{tenantName}</p>
                <p className="text-xs text-muted">Pulse</p>
              </div>
            </div>
            <div className="p-4">
              <div className="rounded-lg p-5" style={{ backgroundColor: primaryColor, color: foreground(primaryColor) }}>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-75">Performance pulse</p>
                <h3 className="mt-2 text-2xl font-bold" style={{ fontFamily: headingFont }}>One clear view of today</h3>
                <p className="mt-2 text-sm opacity-85">Published branding applies across the tenant shell, Pulse and Canvas.</p>
              </div>
              <div className="mt-4 flex items-center gap-3 rounded-lg border border-line p-3">
                <span className="h-8 w-1 rounded-full" style={{ backgroundColor: accentColor }} />
                <div>
                  <p className="text-sm font-semibold text-ink">Semantic status colours stay fixed</p>
                  <p className="text-xs text-muted">Brand colours never replace success, warning or error meaning.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">
          Live: {published.changedAt
            ? `published ${new Date(published.changedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`
            : "Hized defaults"}.
        </p>
      </aside>
    </div>
  );
}
