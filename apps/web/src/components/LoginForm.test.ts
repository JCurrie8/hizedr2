import { describe, expect, it } from "vitest";
import { postLoginDestination } from "./login-routing";

describe("post-login routing", () => {
  it("enters Platform Admin from the dedicated admin hostname", () => {
    expect(postLoginDestination("admin.hized.app")).toBe("/");
    expect(postLoginDestination("admin.localhost")).toBe("/");
  });

  it("keeps apex and tenant sign-ins on the organisation chooser", () => {
    expect(postLoginDestination("hized.app")).toBe("/organisations");
    expect(postLoginDestination("northstar-installations.hized.app")).toBe("/organisations");
  });
});
