import { describe, expect, it } from "vitest";
import {
  accessibleForeground,
  contrastRatio,
  normaliseBrandColor,
  validateAccessibleBrandColor,
} from "./branding";

describe("tenant branding colour safety", () => {
  it("normalises strict six-digit hex colours", () => {
    expect(normaliseBrandColor(" #1a2b3c ")).toBe("#1A2B3C");
    expect(() => normaliseBrandColor("red")).toThrow(/six-digit hex/);
    expect(() => normaliseBrandColor("#fff")).toThrow(/six-digit hex/);
  });

  it("chooses a readable fixed foreground without changing the brand colour", () => {
    expect(accessibleForeground("#0F2A43")).toBe("#FFFFFF");
    expect(accessibleForeground("#F4D35E")).toBe("#081B2C");
    expect(contrastRatio("#0F2A43", "#FFFFFF")).toBeGreaterThan(4.5);
    expect(contrastRatio("#F4D35E", "#081B2C")).toBeGreaterThan(4.5);
  });

  it("accepts colours only with an accessible generated text pairing", () => {
    expect(validateAccessibleBrandColor("#17A2A6")).toBe("#17A2A6");
  });
});
