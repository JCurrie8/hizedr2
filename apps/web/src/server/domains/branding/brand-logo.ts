import sharp from "sharp";

export const MAX_BRAND_LOGO_BYTES = 1024 * 1024;
export const MAX_BRAND_LOGO_DIMENSION = 4096;
export const BRAND_LOGO_CONTENT_TYPES = ["image/png", "image/webp"] as const;
export type BrandLogoContentType = (typeof BRAND_LOGO_CONTENT_TYPES)[number];

export function isBrandLogoContentType(value: string): value is BrandLogoContentType {
  return BRAND_LOGO_CONTENT_TYPES.includes(value as BrandLogoContentType);
}

export async function validateBrandLogo(
  bytes: Uint8Array,
  contentType: BrandLogoContentType,
): Promise<{ width: number; height: number }> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BRAND_LOGO_BYTES) {
    throw new Error("Logo files must be no larger than 1 MB.");
  }
  try {
    const image = sharp(bytes, {
      animated: true,
      failOn: "warning",
      limitInputPixels: MAX_BRAND_LOGO_DIMENSION * MAX_BRAND_LOGO_DIMENSION,
    });
    const metadata = await image.metadata();
    const expectedFormat = contentType === "image/png" ? "png" : "webp";
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) {
      throw new Error("format");
    }
    if ((metadata.pages ?? 1) !== 1) throw new Error("animation");
    if (
      metadata.width > MAX_BRAND_LOGO_DIMENSION ||
      metadata.height > MAX_BRAND_LOGO_DIMENSION
    ) {
      throw new Error("dimensions");
    }
    // Force libvips to decode pixels instead of accepting a plausible header
    // from a truncated/corrupt file. The output is discarded; the original
    // immutable bytes remain the object served after publication.
    await image.clone().resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
    return { width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof Error && error.message === "dimensions") {
      throw new Error("Logo dimensions must be between 1 and 4096 pixels.");
    }
    throw new Error("The uploaded file is not a valid static PNG or WebP image.");
  }
}
