import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { decryptPassword, encryptPassword, validateEncryptionKey } from "../../src/crypto.js";

// Valid 32-byte hex key (64 hex chars)
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("encryptPassword / decryptPassword", () => {
  test("round-trip encrypt and decrypt", () => {
    const plaintext = "my-secret-password";
    const encrypted = encryptPassword(plaintext, TEST_KEY);
    const decrypted = decryptPassword(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  test("passthrough mode when no key is provided writes format byte 0x00", () => {
    const plaintext = "plaintext-password";
    const buf = encryptPassword(plaintext);
    expect(buf[0]).toBe(0x00);
    expect(buf.subarray(1).toString("utf-8")).toBe(plaintext);

    const result = decryptPassword(buf);
    expect(result).toBe(plaintext);
  });

  test("passthrough mode with explicit undefined key", () => {
    const plaintext = "another-password";
    const buf = encryptPassword(plaintext, undefined);
    expect(buf[0]).toBe(0x00);
    expect(buf.subarray(1).toString("utf-8")).toBe(plaintext);

    const result = decryptPassword(buf, undefined);
    expect(result).toBe(plaintext);
  });

  test("format 0x00 (plaintext) decodes correctly even when a key is configured", () => {
    // A consumer always writes format 0x00; PostIMAP must still be able to read it.
    const plaintext = "app-written-password";
    const buf = encryptPassword(plaintext);
    expect(decryptPassword(buf, TEST_KEY)).toBe(plaintext);
  });

  test("encrypted buffer has format byte 0x01", () => {
    const buf = encryptPassword("secret", TEST_KEY);
    expect(buf[0]).toBe(0x01);
  });

  test("format 0x01 without a key throws a clear error", () => {
    const buf = encryptPassword("secret", TEST_KEY);
    expect(() => decryptPassword(buf)).toThrow(/no encryption key configured/);
  });

  test("unknown format byte throws", () => {
    const buf = encryptPassword("secret", TEST_KEY);
    buf[0] = 0x02;
    expect(() => decryptPassword(buf, TEST_KEY)).toThrow(/Unknown credential format byte/);
  });

  test("different plaintexts produce different ciphertexts", () => {
    const enc1 = encryptPassword("password-one", TEST_KEY);
    const enc2 = encryptPassword("password-two", TEST_KEY);
    expect(enc1.equals(enc2)).toBe(false);
  });

  test("same plaintext produces different ciphertexts (random IV)", () => {
    const plaintext = "same-password";
    const enc1 = encryptPassword(plaintext, TEST_KEY);
    const enc2 = encryptPassword(plaintext, TEST_KEY);
    expect(enc1.equals(enc2)).toBe(false);

    // Both should decrypt to the same value
    expect(decryptPassword(enc1, TEST_KEY)).toBe(plaintext);
    expect(decryptPassword(enc2, TEST_KEY)).toBe(plaintext);
  });

  test("handles empty string password", () => {
    const encrypted = encryptPassword("", TEST_KEY);
    const decrypted = decryptPassword(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });

  test("handles unicode passwords", () => {
    const plaintext = "passwort-mit-umlauten-aou";
    const encrypted = encryptPassword(plaintext, TEST_KEY);
    const decrypted = decryptPassword(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  test("handles long passwords", () => {
    const plaintext = "x".repeat(1000);
    const encrypted = encryptPassword(plaintext, TEST_KEY);
    const decrypted = decryptPassword(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  test("encrypted buffer has correct structure (format + IV + ciphertext + tag)", () => {
    const plaintext = "test";
    const encrypted = encryptPassword(plaintext, TEST_KEY);
    // format (1) + IV (12) + ciphertext (>= plaintext length) + tag (16)
    expect(encrypted.length).toBeGreaterThanOrEqual(1 + 12 + plaintext.length + 16);
  });

  test("wrong key fails to decrypt (GCM auth tag verification)", () => {
    const plaintext = "secret";
    const encrypted = encryptPassword(plaintext, TEST_KEY);

    const wrongKey = randomBytes(32).toString("hex");
    expect(() => decryptPassword(encrypted, wrongKey)).toThrow();
  });

  test("tampered ciphertext fails (GCM auth tag verification)", () => {
    const plaintext = "secret";
    const encrypted = encryptPassword(plaintext, TEST_KEY);

    // Tamper with a byte in the ciphertext region (after IV, before tag)
    const tampered = Buffer.from(encrypted);
    tampered[14] ^= 0xff;

    expect(() => decryptPassword(tampered, TEST_KEY)).toThrow();
  });

  test("tampered auth tag fails", () => {
    const plaintext = "secret";
    const encrypted = encryptPassword(plaintext, TEST_KEY);

    // Tamper with the last byte (auth tag region)
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => decryptPassword(tampered, TEST_KEY)).toThrow();
  });

  test("tampered IV fails", () => {
    const plaintext = "secret";
    const encrypted = encryptPassword(plaintext, TEST_KEY);

    // Tamper with the first byte of the IV region (byte 0 is the format prefix)
    const tampered = Buffer.from(encrypted);
    tampered[1] ^= 0xff;

    expect(() => decryptPassword(tampered, TEST_KEY)).toThrow();
  });

  test("truncated buffer fails", () => {
    const plaintext = "secret";
    const encrypted = encryptPassword(plaintext, TEST_KEY);

    // Truncate to just IV + partial ciphertext
    const truncated = encrypted.subarray(0, 15);
    expect(() => decryptPassword(truncated, TEST_KEY)).toThrow();
  });
});

describe("validateEncryptionKey", () => {
  test("valid hex key passes", () => {
    expect(() => validateEncryptionKey(TEST_KEY)).not.toThrow();
  });

  test("randomly generated key passes", () => {
    const key = randomBytes(32).toString("hex");
    expect(() => validateEncryptionKey(key)).not.toThrow();
  });

  test("too short key fails", () => {
    expect(() => validateEncryptionKey("0123456789abcdef")).toThrow(/64 hex characters/);
  });

  test("too long key fails", () => {
    const longKey = "a".repeat(128);
    expect(() => validateEncryptionKey(longKey)).toThrow(/64 hex characters/);
  });

  test("non-hex characters fail", () => {
    const badKey = "g".repeat(64);
    expect(() => validateEncryptionKey(badKey)).toThrow(/64 hex characters/);
  });

  test("empty string fails", () => {
    expect(() => validateEncryptionKey("")).toThrow(/64 hex characters/);
  });

  test("old-format key (not hex) fails", () => {
    // This was the old format in .dev.env.example
    expect(() => validateEncryptionKey("dev-encryption-key-exactly-32-by!")).toThrow(
      /64 hex characters/,
    );
  });
});
