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
import { env, getDatabaseUrl, testTls } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
} from "../../setup/pg-helpers.js";
import { StalwartAdmin } from "../../setup/stalwart-admin.js";

const admin = new StalwartAdmin();
const testEmail = `caps-test-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = "test-caps-password-42";

let sql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let imapClient: ImapClient;

beforeAll(async () => {
  await admin.createAccount(testEmail, testPassword);

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

  test("Stalwart supports IDLE", () => {
    const caps = detectCapabilities(imapClient.client);
    expect(caps.idle).toBe(true);
  });

  test("selects appropriate sync tier", () => {
    const caps = detectCapabilities(imapClient.client);
    const tier = selectSyncTier(caps);
    expect(["qresync", "condstore", "full"]).toContain(tier);
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
