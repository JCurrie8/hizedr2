import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: requiredEnv("R2_ENDPOINT"),
      // R2 supports SigV4 but does not require the SDK's automatic flexible
      // checksum negotiation. Keeping checksums request-driven also prevents a
      // body-less presign from binding a checksum that cannot match the later
      // browser PUT body.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return client;
}

function getBucket(): string {
  return requiredEnv("R2_BUCKET");
}

export interface UploadMetadata {
  tenantId: string;
  pipelineId: string;
  contentSha256: string;
}

export interface BrandingUploadMetadata {
  tenantId: string;
  contentSha256: string;
}

export async function createR2Upload(input: {
  key: string;
  contentType: string;
  metadata: UploadMetadata;
}): Promise<{ uploadUrl: string; headers: Record<string, string>; expiresAt: string }> {
  const metadata = {
    "tenant-id": input.metadata.tenantId,
    "pipeline-id": input.metadata.pipelineId,
    sha256: input.metadata.contentSha256,
  };
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: input.key,
    ContentType: input.contentType,
    Metadata: metadata,
  });
  const expiresIn = 10 * 60;
  const metadataHeaders = new Set([
    "x-amz-meta-tenant-id",
    "x-amz-meta-pipeline-id",
    "x-amz-meta-sha256",
  ]);
  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn,
    // Cloudflare R2 does not persist metadata hoisted into presigned query
    // parameters. Keep it in signed headers so HEAD can verify object ownership
    // and the claimed digest before any bytes are parsed.
    unhoistableHeaders: metadataHeaders,
  });
  return {
    uploadUrl,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    headers: {
      "content-type": input.contentType,
      "x-amz-meta-tenant-id": metadata["tenant-id"],
      "x-amz-meta-pipeline-id": metadata["pipeline-id"],
      "x-amz-meta-sha256": metadata.sha256,
    },
  };
}

export async function createR2BrandingUpload(input: {
  key: string;
  contentType: "image/png" | "image/webp";
  metadata: BrandingUploadMetadata;
}): Promise<{ uploadUrl: string; headers: Record<string, string>; expiresAt: string }> {
  const metadata = {
    "tenant-id": input.metadata.tenantId,
    purpose: "tenant-branding",
    sha256: input.metadata.contentSha256,
  };
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: input.key,
    ContentType: input.contentType,
    Metadata: metadata,
  });
  const expiresIn = 10 * 60;
  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn,
    unhoistableHeaders: new Set([
      "x-amz-meta-tenant-id",
      "x-amz-meta-purpose",
      "x-amz-meta-sha256",
    ]),
  });
  return {
    uploadUrl,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    headers: {
      "content-type": input.contentType,
      "x-amz-meta-tenant-id": metadata["tenant-id"],
      "x-amz-meta-purpose": metadata.purpose,
      "x-amz-meta-sha256": metadata.sha256,
    },
  };
}

export async function uploadR2Object(input: {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  metadata: UploadMetadata;
}): Promise<void> {
  await getClient().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: input.key,
    Body: input.bytes,
    ContentLength: input.bytes.byteLength,
    ContentType: input.contentType,
    Metadata: {
      "tenant-id": input.metadata.tenantId,
      "pipeline-id": input.metadata.pipelineId,
      sha256: input.metadata.contentSha256,
    },
  }));
}

export async function verifyR2Upload(input: {
  key: string;
  sizeBytes: number;
  metadata: UploadMetadata;
}): Promise<void> {
  const result = await getClient().send(new HeadObjectCommand({ Bucket: getBucket(), Key: input.key }));
  if (result.ContentLength !== input.sizeBytes) throw new Error("The uploaded object size does not match the request.");
  if (
    result.Metadata?.["tenant-id"] !== input.metadata.tenantId ||
    result.Metadata?.["pipeline-id"] !== input.metadata.pipelineId ||
    result.Metadata?.sha256 !== input.metadata.contentSha256
  ) {
    throw new Error("The uploaded object metadata is invalid.");
  }
}

export async function verifyR2BrandingUpload(input: {
  key: string;
  sizeBytes: number;
  metadata: BrandingUploadMetadata;
}): Promise<void> {
  const result = await getClient().send(new HeadObjectCommand({ Bucket: getBucket(), Key: input.key }));
  if (result.ContentLength !== input.sizeBytes) throw new Error("The uploaded logo size does not match the request.");
  if (
    result.Metadata?.["tenant-id"] !== input.metadata.tenantId ||
    result.Metadata?.purpose !== "tenant-branding" ||
    result.Metadata?.sha256 !== input.metadata.contentSha256
  ) {
    throw new Error("The uploaded logo metadata is invalid.");
  }
}

export async function downloadR2Object(key: string): Promise<Uint8Array> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  if (!result.Body) throw new Error("The uploaded object has no content.");
  return result.Body.transformToByteArray();
}

export async function deleteR2Object(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}
