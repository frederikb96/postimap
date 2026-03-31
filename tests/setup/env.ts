export const env = {
  // PG (compose defaults, overridden by testcontainers or env vars)
  PG_HOST: process.env.POSTIMAP_TEST_PG_HOST ?? "127.0.0.1",
  PG_PORT: Number.parseInt(process.env.POSTIMAP_TEST_PG_PORT ?? "15432"),
  PG_DATABASE: "postimap_test",
  PG_USER: "testuser",
  PG_PASSWORD: "testpass",

  // Stalwart IMAP
  IMAP_HOST: process.env.POSTIMAP_TEST_IMAP_HOST ?? "127.0.0.1",
  IMAP_PORT: Number.parseInt(process.env.POSTIMAP_TEST_IMAP_PORT ?? "11143"),

  // Stalwart SMTP
  SMTP_HOST: process.env.POSTIMAP_TEST_SMTP_HOST ?? "127.0.0.1",
  SMTP_PORT: Number.parseInt(process.env.POSTIMAP_TEST_SMTP_PORT ?? "11025"),

  // Stalwart Admin API
  STALWART_ADMIN_URL: process.env.POSTIMAP_TEST_STALWART_ADMIN_URL ?? "http://127.0.0.1:18880",
  STALWART_ADMIN_USER: "admin",
  STALWART_ADMIN_PASSWORD: "testadmin123",

  // Toxiproxy
  TOXIPROXY_HOST: process.env.POSTIMAP_TEST_TOXIPROXY_HOST ?? "127.0.0.1",
  TOXIPROXY_PORT: Number.parseInt(process.env.POSTIMAP_TEST_TOXIPROXY_PORT ?? "8474"),
  TOXIPROXY_IMAP_UPSTREAM:
    process.env.POSTIMAP_TEST_TOXIPROXY_IMAP_UPSTREAM ?? "postimap-stalwart-test:1143",

  // Test domain
  TEST_DOMAIN: "test.local",

  // Encryption key for credential encryption testing (exactly 32 bytes)
  ENCRYPTION_KEY: "test-encryption-key-exactly-32-by",
} as const;

/** TLS options for test IMAP connections (Stalwart uses self-signed certs) */
export const testTls = { rejectUnauthorized: false } as const;

export type { ServerCapabilities } from "../../src/imap/capabilities.js";

/**
 * Default server capabilities for test environments (Stalwart test server).
 */
export const testCapabilities: import("../../src/imap/capabilities.js").ServerCapabilities = {
  condstore: false,
  qresync: false,
  idle: true,
  move: true,
  uidplus: true,
  mailboxId: false,
};

export function getDatabaseUrl(schema?: string): string {
  const base = `postgresql://${env.PG_USER}:${env.PG_PASSWORD}@${env.PG_HOST}:${env.PG_PORT}/${env.PG_DATABASE}`;
  if (schema) {
    return `${base}?search_path=${schema}`;
  }
  return base;
}
