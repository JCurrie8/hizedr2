import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateBrandLogo } from "./brand-logo";

async function image(format: "png" | "webp", width: number, height: number): Promise<Uint8Array> {
  const source = sharp({
    create: { width, height, channels: 4, background: { r: 18, g: 59, b: 93, alpha: 1 } },
  });
  return format === "png" ? source.png().toBuffer() : source.webp().toBuffer();
}

describe("tenant brand logo validation", () => {
  it("accepts fully decodable static PNG and WebP images", async () => {
    await expect(validateBrandLogo(await image("png", 800, 240), "image/png"))
      .resolves.toEqual({ width: 800, height: 240 });
    await expect(validateBrandLogo(await image("webp", 600, 180), "image/webp"))
      .resolves.toEqual({ width: 600, height: 180 });
  });

  it("rejects a declared image type whose decoded format does not match", async () => {
    await expect(validateBrandLogo(await image("webp", 100, 100), "image/png"))
      .rejects.toThrow(/valid static PNG or WebP/);
  });

  it("rejects truncated image payloads", async () => {
    const complete = await image("png", 100, 100);
    await expect(validateBrandLogo(complete.slice(0, 32), "image/png"))
      .rejects.toThrow(/valid static PNG or WebP/);
  });

  it("rejects dimensions above the bounded logo size", async () => {
    await expect(validateBrandLogo(await image("png", 4097, 100), "image/png"))
      .rejects.toThrow(/between 1 and 4096/);
  });
});
