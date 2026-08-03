"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { insertAuditLog } from "@/server/domains/access-control/audit";
import {
  getDraftBranding,
  isBrandingTypography,
  publishBranding,
  resetBranding,
  saveBrandingDraft,
  validateAccessibleBrandColor,
} from "@/server/domains/branding/branding";
import {
  isBrandLogoContentType,
  MAX_BRAND_LOGO_BYTES,
  validateBrandLogo,
} from "@/server/domains/branding/brand-logo";
import {
  createR2BrandingUpload,
  deleteR2Object,
  downloadR2Object,
  verifyR2BrandingUpload,
} from "@/server/storage/r2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

async function requireBrandingAdmin() {
  const ctx = await getAuthContextFromRequest();
  if (ctx.kind !== "tenant") throw new Error("Not signed in to a tenant.");
  if (ctx.role !== "company_admin") throw new Error("Only a Company Admin can configure branding.");
  return ctx;
}

export interface PreparedBrandLogoUpload {
  storageKey: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

export async function prepareBrandLogoUploadAction(input: {
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
}): Promise<PreparedBrandLogoUpload> {
  const ctx = await requireBrandingAdmin();
  if (!isBrandLogoContentType(input.contentType)) throw new Error("Choose a PNG or WebP logo.");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_BRAND_LOGO_BYTES) {
    throw new Error("Logo files must be no larger than 1 MB.");
  }
  if (!SHA256_PATTERN.test(input.contentSha256)) throw new Error("The logo digest is invalid.");
  const extension = input.contentType === "image/png" ? "png" : "webp";
  const storageKey = `${ctx.tenant.id}/branding/drafts/${randomUUID()}.${extension}`;
  const upload = await createR2BrandingUpload({
    key: storageKey,
    contentType: input.contentType,
    metadata: { tenantId: ctx.tenant.id, contentSha256: input.contentSha256 },
  });
  return {
    storageKey,
    uploadUrl: upload.uploadUrl,
    uploadHeaders: upload.headers,
    expiresAt: upload.expiresAt,
  };
}

export interface BrandingActionResult {
  saved: boolean;
  message: string;
}

export async function saveBrandingDraftAction(input: {
  primaryColor: string;
  accentColor: string;
  typography: string;
  removeLogo: boolean;
  logo?: {
    storageKey: string;
    contentType: string;
    sizeBytes: number;
    contentSha256: string;
  };
}): Promise<BrandingActionResult> {
  const ctx = await requireBrandingAdmin();
  const primaryColor = validateAccessibleBrandColor(input.primaryColor);
  const accentColor = validateAccessibleBrandColor(input.accentColor);
  const typography = input.typography;
  if (!isBrandingTypography(typography)) throw new Error("Choose an approved typography option.");

  let newLogoKey: string | null | undefined;
  let newLogoContentType: "image/png" | "image/webp" | null | undefined;
  if (input.removeLogo) {
    newLogoKey = null;
    newLogoContentType = null;
  } else if (input.logo) {
    if (!isBrandLogoContentType(input.logo.contentType)) throw new Error("Choose a PNG or WebP logo.");
    if (!SHA256_PATTERN.test(input.logo.contentSha256)) throw new Error("The logo digest is invalid.");
    if (!Number.isInteger(input.logo.sizeBytes) || input.logo.sizeBytes < 1 || input.logo.sizeBytes > MAX_BRAND_LOGO_BYTES) {
      throw new Error("Logo files must be no larger than 1 MB.");
    }
    const requiredPrefix = `${ctx.tenant.id}/branding/drafts/`;
    if (!input.logo.storageKey.startsWith(requiredPrefix) || input.logo.storageKey.includes("..")) {
      throw new Error("The logo storage key is outside this tenant.");
    }
    try {
      await verifyR2BrandingUpload({
        key: input.logo.storageKey,
        sizeBytes: input.logo.sizeBytes,
        metadata: { tenantId: ctx.tenant.id, contentSha256: input.logo.contentSha256 },
      });
      const bytes = await downloadR2Object(input.logo.storageKey);
      const serverHash = createHash("sha256").update(bytes).digest("hex");
      if (serverHash !== input.logo.contentSha256) throw new Error("The uploaded logo digest does not match its content.");
      await validateBrandLogo(bytes, input.logo.contentType);
    } catch (error) {
      await deleteR2Object(input.logo.storageKey).catch(() => {});
      throw error;
    }
    newLogoKey = input.logo.storageKey;
    newLogoContentType = input.logo.contentType;
  }

  let oldDraftLogo: string | null = null;
  let publishedLogo: string | null = null;
  try {
    await withUserContext({ userId: ctx.profileId, tenantId: ctx.tenant.id }, async (client) => {
      const draft = await getDraftBranding(client, { tenantId: ctx.tenant.id });
      const { rows: publishedRows } = await client.query<{ logo_object_key: string | null }>(
        "select logo_object_key from public.tenant_branding where tenant_id = $1",
        [ctx.tenant.id],
      );
      oldDraftLogo = draft.logoObjectKey;
      publishedLogo = publishedRows[0]?.logo_object_key ?? null;
      await saveBrandingDraft(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        logoObjectKey: newLogoKey === undefined ? draft.logoObjectKey : newLogoKey,
        logoContentType: newLogoContentType === undefined ? draft.logoContentType : newLogoContentType,
        primaryColor,
        accentColor,
        typography,
      });
    });
  } catch (error) {
    if (newLogoKey) await deleteR2Object(newLogoKey).catch(() => {});
    throw error;
  }

  if (oldDraftLogo && oldDraftLogo !== publishedLogo && oldDraftLogo !== newLogoKey) {
    await deleteR2Object(oldDraftLogo).catch(() => {});
  }
  revalidatePath("/admin/branding");
  return { saved: true, message: "Draft saved. Review the preview, then publish when ready." };
}

export async function publishBrandingAction(): Promise<BrandingActionResult> {
  const ctx = await requireBrandingAdmin();
  const published = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const result = await publishBranding(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "branding.published",
        targetType: "tenant_branding",
        targetId: ctx.tenant.id,
        metadata: {
          changedFields: result.changedFields,
          typography: result.theme.typography,
          hasLogo: Boolean(result.theme.logoObjectKey),
        },
      });
      return result;
    },
  );
  if (published.previousLogoObjectKey && published.previousLogoObjectKey !== published.theme.logoObjectKey) {
    await deleteR2Object(published.previousLogoObjectKey).catch(() => {});
  }
  revalidatePath("/", "layout");
  revalidatePath("/admin/branding");
  return { saved: true, message: "Branding published across this tenant." };
}

export async function resetBrandingAction(): Promise<BrandingActionResult> {
  const ctx = await requireBrandingAdmin();
  const result = await withUserContext(
    { userId: ctx.profileId, tenantId: ctx.tenant.id },
    async (client) => {
      const reset = await resetBranding(client, { tenantId: ctx.tenant.id, actorUserId: ctx.profileId });
      await insertAuditLog(client, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.profileId,
        action: "branding.reset",
        targetType: "tenant_branding",
        targetId: ctx.tenant.id,
        metadata: { restored: "hized_defaults" },
      });
      return reset;
    },
  );
  await Promise.all(result.removedLogoObjectKeys.map((key) => deleteR2Object(key).catch(() => {})));
  revalidatePath("/", "layout");
  revalidatePath("/admin/branding");
  return { saved: true, message: "Hized defaults restored and published." };
}
