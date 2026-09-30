import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// OAuth access/refresh tokens are encrypted at rest (AES-256-GCM) before
// they ever touch the database, and decrypted only inside server code that
// needs to make a provider API call. They are never sent to the client.
const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  // Derive a 32-byte key regardless of the raw secret's length/format.
  return scryptSync(secret, "director-ltd-token-encryption", 32);
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptToken(ciphertext: string): string {
  const key = getKey();
  const [ivB64, authTagB64, dataB64] = ciphertext.split(".");
  if (!ivB64 || !authTagB64 || !dataB64) throw new Error("Malformed encrypted token");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}
