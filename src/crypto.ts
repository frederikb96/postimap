import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/** Wire format: a 1-byte version prefix on the stored bytea. */
const FORMAT_PLAINTEXT = 0x00;
const FORMAT_AES_256_GCM = 0x01;

/**
 * Encrypt a plaintext password. Binary format: [1-byte format][payload].
 *
 * Format 0x01 (AES-256-GCM): payload is [12-byte IV][ciphertext][16-byte auth tag].
 * Format 0x00 (plaintext): payload is the UTF-8 bytes as-is.
 *
 * If no hex key is provided, writes format 0x00 (passthrough mode). This is also the
 * format consumers write -- PostIMAP is the only party that ever produces format 0x01.
 */
export function encryptPassword(plaintext: string, hexKey?: string): Buffer {
  if (!hexKey) {
    return Buffer.concat([Buffer.from([FORMAT_PLAINTEXT]), Buffer.from(plaintext, "utf-8")]);
  }

  const key = Buffer.from(hexKey, "hex");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_AES_256_GCM]), iv, encrypted, tag]);
}

/**
 * Decrypt a password buffer written by {@link encryptPassword}.
 *
 * The format byte is authoritative: a format-0x00 buffer decodes as plaintext
 * regardless of whether a key is configured, and a format-0x01 buffer requires one.
 * This is what lets toggling ENCRYPTION_KEY on an existing deployment fail loudly
 * instead of silently producing garbage, and lets either format be re-encrypted to the
 * other without guessing.
 */
export function decryptPassword(buf: Buffer, hexKey?: string): string {
  if (buf.length < 1) {
    throw new Error("Invalid credential buffer: empty");
  }

  const format = buf[0];
  const payload = buf.subarray(1);

  if (format === FORMAT_PLAINTEXT) {
    return payload.toString("utf-8");
  }

  if (format === FORMAT_AES_256_GCM) {
    if (!hexKey) {
      throw new Error(
        "Cannot decrypt AES-256-GCM credential: no encryption key configured (ENCRYPTION_KEY)",
      );
    }
    const key = Buffer.from(hexKey, "hex");
    const iv = payload.subarray(0, IV_LEN);
    const tag = payload.subarray(payload.length - TAG_LEN);
    const ciphertext = payload.subarray(IV_LEN, payload.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString("utf-8") + decipher.final("utf-8");
  }

  throw new Error(`Unknown credential format byte: 0x${format.toString(16).padStart(2, "0")}`);
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
