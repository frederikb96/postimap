export const env = {
  // PG (set by global-setup once the testcontainers instance is up)
  PG_HOST: process.env.POSTIMAP_TEST_PG_HOST ?? "127.0.0.1",
  PG_PORT: Number.parseInt(process.env.POSTIMAP_TEST_PG_PORT ?? "5432", 10),
  PG_DATABASE: "postimap_test",
  PG_USER: "testuser",
  PG_PASSWORD: "testpass",

  // Mail server IMAP
  IMAP_HOST: process.env.POSTIMAP_TEST_IMAP_HOST ?? "127.0.0.1",
  IMAP_PORT: Number.parseInt(process.env.POSTIMAP_TEST_IMAP_PORT ?? "31143", 10),

  // Mail server LMTP (implicit TLS) — used only by the test harness to inject mail,
  // simulating externally-arriving messages. Distinct from the outbox's own SMTP send
  // path, which talks to Mailpit below.
  LMTP_HOST: process.env.POSTIMAP_TEST_LMTP_HOST ?? "127.0.0.1",
  LMTP_PORT: Number.parseInt(process.env.POSTIMAP_TEST_LMTP_PORT ?? "31024", 10),

  // Mailpit -- the SMTP sink outbox tests point account.smtp_host/port at, so a real
  // send can be proven by asking Mailpit's HTTP API what it received, rather than
  // mocking the transport. Accepts any SMTP AUTH credentials by default.
  MAILPIT_HOST: process.env.POSTIMAP_TEST_MAILPIT_HOST ?? "127.0.0.1",
  MAILPIT_SMTP_PORT: Number.parseInt(process.env.POSTIMAP_TEST_MAILPIT_SMTP_PORT ?? "11025", 10),
  MAILPIT_HTTP_PORT: Number.parseInt(process.env.POSTIMAP_TEST_MAILPIT_HTTP_PORT ?? "18025", 10),

  // Toxiproxy
  TOXIPROXY_HOST: process.env.POSTIMAP_TEST_TOXIPROXY_HOST ?? "127.0.0.1",
  TOXIPROXY_PORT: Number.parseInt(process.env.POSTIMAP_TEST_TOXIPROXY_PORT ?? "8474", 10),
  TOXIPROXY_IMAP_UPSTREAM: process.env.POSTIMAP_TEST_TOXIPROXY_IMAP_UPSTREAM ?? "mailserver:31143",
  // Host-mapped listen ports for chaos proxies, assigned dynamically by global-setup
  TOXIPROXY_IMAP_PORT: Number.parseInt(
    process.env.POSTIMAP_TEST_TOXIPROXY_IMAP_PORT ?? "21001",
    10,
  ),
  TOXIPROXY_SLOW_PORT: Number.parseInt(
    process.env.POSTIMAP_TEST_TOXIPROXY_SLOW_PORT ?? "23001",
    10,
  ),

  // Test domain
  TEST_DOMAIN: "test.local",

  // Shared password for every test mailbox. The mail server authenticates any username
  // against this single static password — there is no per-account provisioning API, so
  // account "creation" is just picking a unique email address and connecting with it.
  MAIL_PASSWORD: "postimap-test-password",

  // Encryption key for credential encryption testing (exactly 32 bytes)
  ENCRYPTION_KEY: "test-encryption-key-exactly-32-by",
} as const;

/** TLS options for test IMAP connections (self-signed certs) */
export const testTls = { rejectUnauthorized: false } as const;

export type { ServerCapabilities } from "../../src/imap/capabilities.js";

/**
 * Capabilities of the test mail server. Asserted for real in
 * tests/integration/imap/capabilities.test.ts — update here only after re-verifying there.
 */
export const testCapabilities: import("../../src/imap/capabilities.js").ServerCapabilities = {
  condstore: true,
  qresync: true,
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
