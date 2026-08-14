import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const KEY_VERSION = 1;
type SecretPurpose = "credentials" | "oauth-state";

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

function masterKey(): Buffer {
  const encoded = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!encoded) throw new Error("CONNECTOR_ENCRYPTION_KEY is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) throw new Error("CONNECTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function purposeKey(purpose: SecretPurpose): Buffer {
  return createHmac("sha256", masterKey()).update(`hized:${purpose}:v${KEY_VERSION}`).digest();
}

export function sealConnectorValue(value: unknown, purpose: SecretPurpose, aad: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", purposeKey(purpose), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

export function openConnectorValue<T>(sealed: SealedValue, purpose: SecretPurpose, aad: string): T {
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

export function sealedValueFromRow(row: Record<string, unknown>): SealedValue {
  return {
    ciphertext: Buffer.from(row.ciphertext as Uint8Array),
    iv: Buffer.from(row.iv as Uint8Array),
    authTag: Buffer.from(row.auth_tag as Uint8Array),
    keyVersion: Number(row.key_version),
  };
}
