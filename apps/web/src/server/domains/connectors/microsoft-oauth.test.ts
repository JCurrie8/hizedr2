import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMicrosoftOAuthState,
  openMicrosoftCredentials,
  openMicrosoftOAuthState,
  sealMicrosoftCredentials,
  type MicrosoftCredentials,
} from "./microsoft-oauth";

describe("Microsoft connector secret protection", () => {
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
  });

  it("binds encrypted credentials to their tenant and connector", () => {
    const credentials: MicrosoftCredentials = {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2026-08-03T12:00:00.000Z",
      scope: "Files.Read.All",
      tokenType: "Bearer",
    };
    const sealed = sealMicrosoftCredentials(credentials, { tenantId: "tenant-a", connectorId: "connector-a" });
    expect(openMicrosoftCredentials(sealed, { tenantId: "tenant-a", connectorId: "connector-a" })).toEqual(credentials);
    expect(() => openMicrosoftCredentials(sealed, { tenantId: "tenant-b", connectorId: "connector-a" }))
      .toThrow(/could not be authenticated/);
  });

  it("rejects tampered OAuth state", () => {
    const state = createMicrosoftOAuthState({
      tenantId: "tenant-a",
      tenantSlug: "northstar",
      profileId: "profile-a",
      connectorName: "Forms responses",
    });
    const opened = openMicrosoftOAuthState(state);
    expect(opened).toMatchObject({ tenantId: "tenant-a", tenantSlug: "northstar", profileId: "profile-a" });
    const parts = state.split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    ciphertext[0] = ciphertext[0]! ^ 1;
    parts[3] = ciphertext.toString("base64url");
    const tampered = parts.join(".");
    expect(() => openMicrosoftOAuthState(tampered)).toThrow(/could not be authenticated/);
  });
});
