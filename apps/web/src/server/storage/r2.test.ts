import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createR2Upload, deleteR2Object, downloadR2Object, verifyR2Upload } from "./r2";

const hasR2Environment = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
  .every((name) => Boolean(process.env[name]));

describe.skipIf(!hasR2Environment)("R2 source object storage", () => {
  it.each(["https://hized-platform.vercel.app", "https://northstar-installations.hized.com"])(
    "allows browser uploads from %s",
    async (origin) => {
      const upload = await createR2Upload({
        key: `integration-tests/${randomUUID()}.csv`,
        contentType: "text/csv",
        metadata: { tenantId: randomUUID(), pipelineId: randomUUID(), contentSha256: "a".repeat(64) },
      });
      const response = await fetch(upload.uploadUrl, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type,x-amz-meta-tenant-id,x-amz-meta-pipeline-id,x-amz-meta-sha256",
        },
      });
      expect(
        response.ok,
        `status=${response.status}, allowOrigin=${response.headers.get("access-control-allow-origin")}, body=${await response.text()}`,
      ).toBe(true);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    },
  );

  it("presigns, verifies, downloads and removes an exact private object", async () => {
    const bytes = new TextEncoder().encode("Response ID,Score\na,7\n");
    const key = `integration-tests/${randomUUID()}.csv`;
    const metadata = { tenantId: randomUUID(), pipelineId: randomUUID(), contentSha256: "a".repeat(64) };
    try {
      const upload = await createR2Upload({ key, contentType: "text/csv", metadata });
      const response = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers, body: bytes });
      if (!response.ok) {
        const signedUrl = new URL(upload.uploadUrl);
        const queryNames = [...signedUrl.searchParams.keys()].sort().join(",");
        const signedHeaders = signedUrl.searchParams.get("X-Amz-SignedHeaders") ?? "missing";
        const pathSegments = signedUrl.pathname.split("/").filter(Boolean).length;
        const isR2Host = signedUrl.hostname.endsWith(".r2.cloudflarestorage.com");
        throw new Error(
          `R2 PUT failed with ${response.status}: hostIsR2=${isR2Host}, pathSegments=${pathSegments}, ` +
            `signedHeaders=${signedHeaders}, queryNames=${queryNames}: ${await response.text()}`,
        );
      }
      await verifyR2Upload({ key, sizeBytes: bytes.byteLength, metadata });
      expect(await downloadR2Object(key)).toEqual(bytes);
    } finally {
      await deleteR2Object(key);
    }
  });
});
