import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const AUTHORIZE_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const KEY_VERSION = 1;
const STATE_TTL_MS = 10 * 60 * 1_000;
const SCOPES = ["offline_access", "User.Read", "Files.Read.All", "Sites.Read.All"];

export interface MicrosoftCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
  tokenType: string;
}

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface MicrosoftOAuthState {
  tenantId: string;
  tenantSlug: string;
  profileId: string;
  connectorName: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function masterKey(): Buffer {
  const encoded = requiredEnv("CONNECTOR_ENCRYPTION_KEY");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) throw new Error("CONNECTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function purposeKey(purpose: "credentials" | "oauth-state"): Buffer {
  return createHmac("sha256", masterKey()).update(`hized:${purpose}:v${KEY_VERSION}`).digest();
}

function sealJson(value: unknown, purpose: "credentials" | "oauth-state", aad: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", purposeKey(purpose), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

function openJson<T>(sealed: SealedValue, purpose: "credentials" | "oauth-state", aad: string): T {
  if (sealed.keyVersion !== KEY_VERSION) throw new Error("The connector secret uses an unsupported key version.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", purposeKey(purpose), sealed.iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.authTag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new Error("The connector secret could not be authenticated.");
  }
}

export function microsoftConnectorEnvironmentReady(): boolean {
  return ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_REDIRECT_URI", "CONNECTOR_ENCRYPTION_KEY"]
    .every((name) => Boolean(process.env[name]));
}

export function sealMicrosoftCredentials(
  credentials: MicrosoftCredentials,
  binding: { tenantId: string; connectorId: string },
): SealedValue {
  return sealJson(credentials, "credentials", `${binding.tenantId}:${binding.connectorId}`);
}

export function openMicrosoftCredentials(
  sealed: SealedValue,
  binding: { tenantId: string; connectorId: string },
): MicrosoftCredentials {
  const credentials = openJson<MicrosoftCredentials>(sealed, "credentials", `${binding.tenantId}:${binding.connectorId}`);
  if (!credentials.accessToken || !credentials.refreshToken || !credentials.expiresAt) {
    throw new Error("The Microsoft credential payload is incomplete.");
  }
  return credentials;
}

export function createMicrosoftOAuthState(input: Omit<MicrosoftOAuthState, "nonce" | "codeVerifier" | "expiresAt">): string {
  const state: MicrosoftOAuthState = {
    ...input,
    nonce: randomBytes(16).toString("base64url"),
    codeVerifier: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const sealed = sealJson(state, "oauth-state", "microsoft-oauth-state");
  return [sealed.keyVersion, sealed.iv.toString("base64url"), sealed.authTag.toString("base64url"), sealed.ciphertext.toString("base64url")].join(".");
}

export function openMicrosoftOAuthState(value: string): MicrosoftOAuthState {
  const [version, iv, authTag, ciphertext, ...extra] = value.split(".");
  if (!version || !iv || !authTag || !ciphertext || extra.length > 0) throw new Error("The Microsoft authorization state is invalid.");
  const state = openJson<MicrosoftOAuthState>({
    keyVersion: Number(version),
    iv: Buffer.from(iv, "base64url"),
    authTag: Buffer.from(authTag, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
  }, "oauth-state", "microsoft-oauth-state");
  if (!state.tenantId || !state.tenantSlug || !state.profileId || !state.connectorName || !state.nonce || !state.codeVerifier) {
    throw new Error("The Microsoft authorization state is incomplete.");
  }
  if (!Number.isFinite(state.expiresAt) || state.expiresAt < Date.now()) {
    throw new Error("The Microsoft authorization request has expired.");
  }
  return state;
}

export function createMicrosoftAuthorizationUrl(state: string): string {
  const openedState = openMicrosoftOAuthState(state);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", requiredEnv("MICROSOFT_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", requiredEnv("MICROSOFT_REDIRECT_URI"));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(openedState.codeVerifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || payload.error) {
    throw new Error("Microsoft rejected the connector authorization request. Please reconnect and try again.");
  }
  return payload;
}

function normalizeTokens(payload: TokenResponse, previousRefreshToken?: string): MicrosoftCredentials {
  if (!payload.access_token || !Number.isFinite(payload.expires_in) || Number(payload.expires_in) <= 0) {
    throw new Error("Microsoft returned an incomplete access token response.");
  }
  const refreshToken = payload.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new Error("Microsoft did not grant offline access for background synchronization.");
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + Number(payload.expires_in) * 1_000).toISOString(),
    scope: payload.scope ?? SCOPES.join(" "),
    tokenType: payload.token_type ?? "Bearer",
  };
}

export async function exchangeMicrosoftAuthorizationCode(code: string, codeVerifier: string): Promise<MicrosoftCredentials> {
  const body = new URLSearchParams({
    client_id: requiredEnv("MICROSOFT_CLIENT_ID"),
    client_secret: requiredEnv("MICROSOFT_CLIENT_SECRET"),
    redirect_uri: requiredEnv("MICROSOFT_REDIRECT_URI"),
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    scope: SCOPES.join(" "),
  });
  return normalizeTokens(await requestTokens(body));
}

export async function refreshMicrosoftCredentials(credentials: MicrosoftCredentials): Promise<MicrosoftCredentials> {
  const body = new URLSearchParams({
    client_id: requiredEnv("MICROSOFT_CLIENT_ID"),
    client_secret: requiredEnv("MICROSOFT_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    scope: SCOPES.join(" "),
  });
  return normalizeTokens(await requestTokens(body), credentials.refreshToken);
}

export async function ensureFreshMicrosoftCredentials(credentials: MicrosoftCredentials): Promise<{
  credentials: MicrosoftCredentials;
  refreshed: boolean;
}> {
  const expiresAt = Date.parse(credentials.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 2 * 60 * 1_000) {
    return { credentials, refreshed: false };
  }
  return { credentials: await refreshMicrosoftCredentials(credentials), refreshed: true };
}

export function microsoftRedirectUri(): string {
  return requiredEnv("MICROSOFT_REDIRECT_URI");
}
