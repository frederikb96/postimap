import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import {
  cacheCapabilities,
  detectCapabilities,
  getCachedCapabilities,
  selectSyncTier,
} from "../../../src/imap/capabilities.js";
import { ImapClient } from "../../../src/imap/pool.js";
import { env, getDatabaseUrl, testCapabilities, testTls } from "../../setup/env.js";
import { MailServerAdmin } from "../../setup/mailserver-admin.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
} from "../../setup/pg-helpers.js";

const admin = new MailServerAdmin();
const testEmail = `caps-test-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = env.MAIL_PASSWORD;

let sql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let imapClient: ImapClient;

beforeAll(async () => {
  await admin.createAccount(testEmail);

  sql = connectPg();
  schema = await createTestSchema(sql);
  db = createTestDb(getDatabaseUrl(schema));

  imapClient = new ImapClient({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: testEmail,
    password: testPassword,
    tls: testTls,
    retry: { maxRetries: 0 },
  });
  imapClient.on("error", () => {});
  await imapClient.connect();
});

afterAll(async () => {
  await imapClient.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await db.destroy();
  await dropTestSchema(sql, schema);
  await sql.end();
  await admin.deleteAccount(testEmail);
});

describe("capability detection", () => {
  test("detects capabilities from connected client", () => {
    const caps = detectCapabilities(imapClient.client);
    expect(typeof caps.condstore).toBe("boolean");
    expect(typeof caps.qresync).toBe("boolean");
    expect(typeof caps.idle).toBe("boolean");
    expect(typeof caps.move).toBe("boolean");
    expect(typeof caps.uidplus).toBe("boolean");
    expect(typeof caps.mailboxId).toBe("boolean");
  });

  test("advertises CONDSTORE and QRESYNC (RFC 7162)", () => {
    // Hard assertion, not a self-skip: these two tiers of change-detector.ts get zero
    // exercise if the test server doesn't genuinely support them. If this starts
    // failing, testCapabilities in env.ts is lying about what the server can do.
    const caps = detectCapabilities(imapClient.client);
    expect(caps.condstore).toBe(true);
    expect(caps.qresync).toBe(true);
  });

  test("matches the capabilities declared in testCapabilities", () => {
    const caps = detectCapabilities(imapClient.client);
    expect(caps).toEqual(testCapabilities);
  });

  test("selects the QRESYNC tier given the server's real capabilities", () => {
    const caps = detectCapabilities(imapClient.client);
    expect(selectSyncTier(caps)).toBe("qresync");
  });
});

describe("capability caching", () => {
  let accountId: string;

  beforeAll(async () => {
    // Insert a test account into the schema
    const result = await db
      .insertInto("accounts")
      .values({
        name: `caps-cache-test-${randomUUID().slice(0, 8)}`,
        imap_host: env.IMAP_HOST,
        imap_port: env.IMAP_PORT,
        imap_user: testEmail,
        imap_password: Buffer.from("encrypted-placeholder"),
        smtp_host: null,
        smtp_port: null,
        smtp_user: null,
        smtp_password: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    accountId = result.id;
  });

  test("caches capabilities to PG and retrieves them", async () => {
    const caps = detectCapabilities(imapClient.client);
    await cacheCapabilities(db, accountId, caps);

    const cached = await getCachedCapabilities(db, accountId);
    expect(cached).not.toBeNull();
    expect(cached?.idle).toBe(caps.idle);
    expect(cached?.condstore).toBe(caps.condstore);
    expect(cached?.qresync).toBe(caps.qresync);
    expect(cached?.move).toBe(caps.move);
    expect(cached?.uidplus).toBe(caps.uidplus);
    expect(cached?.mailboxId).toBe(caps.mailboxId);
  });

  test("returns null when no capabilities cached", async () => {
    const cached = await getCachedCapabilities(db, randomUUID());
    expect(cached).toBeNull();
  });
});
