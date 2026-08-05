import { describe, it, expect } from "vitest";
import { mfaEnrolmentRedirect, tenantRoleRequiresMfa } from "./mfa-policy";

describe("MFA policy", () => {
  it("requires a second factor from Company Admins but not ordinary members", () => {
    expect(tenantRoleRequiresMfa("company_admin")).toBe(true);
    for (const role of ["executive", "functional_leader", "manager", "employee", "analyst"] as const) {
      expect(tenantRoleRequiresMfa(role)).toBe(false);
    }
  });

  it("sends an unenrolled Company Admin to enrolment", () => {
    expect(
      mfaEnrolmentRedirect({ scope: "tenant", role: "company_admin", twoFactorEnabled: false, pathname: "/home" }),
    ).toBe("/admin/security");
  });

  it("lets an enrolled Company Admin through", () => {
    expect(
      mfaEnrolmentRedirect({ scope: "tenant", role: "company_admin", twoFactorEnabled: true, pathname: "/home" }),
    ).toBeNull();
  });

  it("does not block ordinary members who have no second factor", () => {
    expect(
      mfaEnrolmentRedirect({ scope: "tenant", role: "manager", twoFactorEnabled: false, pathname: "/home" }),
    ).toBeNull();
  });

  it("always requires a second factor from platform admins, regardless of tenant role", () => {
    expect(
      mfaEnrolmentRedirect({ scope: "platform_admin", twoFactorEnabled: false, pathname: "/" }),
    ).toBe("/platform-admin/security");
    expect(
      mfaEnrolmentRedirect({ scope: "platform_admin", twoFactorEnabled: true, pathname: "/" }),
    ).toBeNull();
  });

  it("does not trap the user in a redirect loop on the enrolment page itself", () => {
    // The whole enforcement is worthless if the page that satisfies it is
    // also gated by it — this is the regression that matters most here.
    expect(
      mfaEnrolmentRedirect({
        scope: "tenant",
        role: "company_admin",
        twoFactorEnabled: false,
        pathname: "/admin/security",
      }),
    ).toBeNull();
    expect(
      mfaEnrolmentRedirect({
        scope: "platform_admin",
        twoFactorEnabled: false,
        pathname: "/platform-admin/security",
      }),
    ).toBeNull();
  });

  it("treats a nested path under the exempt page as exempt, but not a lookalike prefix", () => {
    expect(
      mfaEnrolmentRedirect({
        scope: "tenant",
        role: "company_admin",
        twoFactorEnabled: false,
        pathname: "/admin/security/backup-codes",
      }),
    ).toBeNull();
    // /admin/security-settings must NOT slip through on a naive startsWith.
    expect(
      mfaEnrolmentRedirect({
        scope: "tenant",
        role: "company_admin",
        twoFactorEnabled: false,
        pathname: "/admin/security-settings",
      }),
    ).toBe("/admin/security");
  });
});
