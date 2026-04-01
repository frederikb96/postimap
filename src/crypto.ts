import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Encrypt a plaintext password using AES-256-GCM.
 * Binary format: [12-byte IV][ciphertext][16-byte auth tag]
 *
 * If no hex key is provided, returns the plaintext as a UTF-8 buffer (passthrough mode).
 */
export function encryptPassword(plaintext: string, hexKey?: string): Buffer {
  if (!hexKey) return Buffer.from(plaintext, "utf-8");

  const key = Buffer.from(hexKey, "hex");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

/**
 * Decrypt a password buffer encrypted with AES-256-GCM.
 * Expects binary format: [12-byte IV][ciphertext][16-byte auth tag]
 *
 * If no hex key is provided, returns the buffer as a UTF-8 string (passthrough mode).
 */
export function decryptPassword(buf: Buffer, hexKey?: string): string {
  if (!hexKey) return buf.toString("utf-8");

  const key = Buffer.from(hexKey, "hex");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf-8") + decipher.final("utf-8");
}

/**
 * Validate an encryption key by performing a round-trip encrypt/decrypt.
 * Throws if the key is invalid or the round-trip fails.
 */
export function validateEncryptionKey(hexKey: string): void {
  if (hexKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error(
      `Invalid encryption key: expected 64 hex characters (32 bytes), got ${hexKey.length} characters`,
    );
  }

  const test = "validation-test";
  const encrypted = encryptPassword(test, hexKey);
  const decrypted = decryptPassword(encrypted, hexKey);
  if (decrypted !== test) {
    throw new Error("Encryption key validation failed: round-trip mismatch");
  }
}
