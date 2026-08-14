"use client";

import { useState, type FormEvent } from "react";
import type { ManualFilePipeline } from "@/server/domains/connectors/connectors";
import { finaliseManualUploadAction, prepareManualUploadAction } from "./actions";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
type UploadPipeline = Pick<ManualFilePipeline, "id" | "name" | "loadMode" | "recordCount">;

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ManualUploadForm({ pipelines }: { pipelines: UploadPipeline[] }) {
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedPipelineId, setSelectedPipelineId] = useState(pipelines[0]?.id ?? "");
  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? pipelines[0];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const pipelineId = String(formData.get("pipelineId") ?? "");
    const confirmSnapshotReplace = formData.get("confirmSnapshotReplace") === "on";
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setStatus("Choose a CSV or XLSX file first.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus("Files must be 10 MB or smaller.");
      return;
    }

    setSubmitting(true);
    setStatus("Hashing file…");
    try {
      const contentSha256 = toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      setStatus("Preparing secure upload…");
      const prepared = await prepareManualUploadAction({
        pipelineId,
        fileName: file.name,
        sizeBytes: file.size,
        contentSha256,
        confirmSnapshotReplace,
      });
      setStatus("Uploading to secure storage…");
      const uploadResponse = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: prepared.uploadHeaders,
        body: file,
      });
      if (!uploadResponse.ok) throw new Error(`Storage upload failed (${uploadResponse.status}).`);

      setStatus("Validating and loading rows…");
      const result = await finaliseManualUploadAction({
        pipelineId: prepared.pipelineId,
        connectorId: prepared.connectorId,
        storageKey: prepared.storageKey,
        fileName: file.name,
        sizeBytes: file.size,
        contentSha256,
        sourceLastModified: file.lastModified || null,
        confirmSnapshotReplace,
      });
      if (result.duplicate) {
        setStatus("This unchanged file revision was already processed; no rows were duplicated.");
      } else {
        const replacement = result.rowsReplaced > 0 ? `; ${result.rowsReplaced} previous rows replaced` : "";
        setStatus(`${result.acceptedRows} rows loaded${replacement}${result.rejectedRows ? `; ${result.rejectedRows} quarantined` : ""}.`);
        form.reset();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 md:grid-cols-[2fr_2fr_auto] md:items-end">
      <label className="text-xs font-semibold uppercase tracking-wide text-muted">
        Pipeline
        <select name="pipelineId" required value={selectedPipelineId} onChange={(event) => setSelectedPipelineId(event.target.value)} className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-text">
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name} · {pipeline.loadMode}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold uppercase tracking-wide text-muted">
        CSV or XLSX file
        <input name="file" type="file" required accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="mt-1 block w-full rounded border border-line bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-text" />
        <span className="mt-1 block font-normal normal-case tracking-normal">Maximum 10 MB</span>
      </label>
      <button disabled={submitting} type="submit" className="rounded bg-navy px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
        {submitting ? "Working…" : "Upload and run"}
      </button>
      {selectedPipeline?.loadMode === "snapshot" && (
        <label className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 md:col-span-3">
          <input name="confirmSnapshotReplace" type="checkbox" required className="mr-2" />
          Replace all {selectedPipeline.recordCount.toLocaleString("en-GB")} current rows in <strong>{selectedPipeline.name}</strong> with the accepted rows from this file. Empty or fully quarantined files are rejected and preserve the current dataset.
        </label>
      )}
      <p aria-live="polite" className="text-sm text-muted md:col-span-3">{status}</p>
    </form>
  );
}
