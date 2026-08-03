import { describe, expect, it } from "vitest";
import { activeSection } from "./TenantNavigation";

describe("tenant navigation active state", () => {
  it.each([
    ["/home", "home"],
    ["/dashboard", "pulse"],
    ["/admin/connect", "connect"],
    ["/admin/connect/pipelines/123", "connect"],
    ["/admin", "settings"],
    ["/admin/branding", "settings"],
    ["/t/northstar-installations/home", "home"],
    ["/t/northstar-installations/dashboard", "pulse"],
    ["/t/northstar-installations/admin/users", "settings"],
  ])("maps %s to %s", (pathname, expected) => {
    expect(activeSection(pathname)).toBe(expected);
  });
});
