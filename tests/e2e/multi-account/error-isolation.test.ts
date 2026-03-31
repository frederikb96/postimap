import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { ImapClient } from "../../../src/imap/pool.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  StalwartAdmin,
  connectImap,
  connectPg,
  createTestDb,
  createTestSchema,
  deliverAndWait,
  dropTestSchema,
  env,
  getDatabaseUrl,
  testCapabilities,
  testTls,
} from "../../setup/e2e-helpers.js";

const admin = new StalwartAdmin();
const suffix = randomUUID().slice(0, 8);

const validEmail = `e2e-eriso-valid-${suffix}@${env.TEST_DOMAIN}`;
const validPassword = "eriso-valid-pass-42";
const validAccountId = randomUUID();
const validFolderId = randomUUID();

const invalidEmail = `e2e-eriso-invalid-${suffix}@${env.TEST_DOMAIN}`;
const invalidAccountId = randomUUID();
const invalidFolderId = randomUUID();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let validImapClient: ImapClient;

beforeAll(async () => {
  await admin.createAccount(validEmail, validPassword);
  // Do NOT create the invalid account on Stalwart so IMAP auth fails

  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));

  // Valid account in PG
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (
      ${validAccountId}, ${validEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${validEmail}, ${Buffer.from(validPassword)},
      ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${validEmail}, ${Buffer.from(validPassword)},
      true, 'active'
    )
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${validFolderId}, ${validAccountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  // Invalid account in PG (wrong password -- account does not exist on Stalwart)
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (
      ${invalidAccountId}, ${invalidEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${invalidEmail}, ${Buffer.from("wrong-password-no-account")},
      ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${invalidEmail}, ${Buffer.from("wrong")},
      true, 'active'
    )
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${invalidFolderId}, ${invalidAccountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  validImapClient = new ImapClient({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: validEmail,
    password: validPassword,
    tls: testTls,
    retry: { maxRetries: 0, baseDelay: 100 },
  });
  validImapClient.on("error", () => {});
  await validImapClient.connect();
});

afterAll(async () => {
  if (validImapClient?.isConnected()) await validImapClient.disconnect();
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
  await admin.deleteAccount(validEmail);
});

describe("E2E: multi-account error isolation", () => {
  test("invalid account errors while valid account syncs normally", async () => {
    const uniqueSubject = `ErrorIso ${suffix}`;

    const checkClient = await connectImap({ user: validEmail, password: validPassword });
    try {
      await deliverAndWait({
        from: validEmail,
        to: validEmail,
        subject: uniqueSubject,
        text: "Body for error isolation test.",
        auth: { user: validEmail, pass: validPassword },
        imapClient: checkClient,
      });
    } finally {
      await checkClient.logout();
    }

    // Attempt to connect IMAP for invalid account -- should fail
    const invalidImapClient = new ImapClient({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: invalidEmail,
      password: "wrong-password-no-account",
      tls: testTls,
      retry: { maxRetries: 0, baseDelay: 100 },
    });
    invalidImapClient.on("error", () => {});

    let invalidConnectFailed = false;
    try {
      await invalidImapClient.connect();
    } catch {
      invalidConnectFailed = true;
    }

    expect(invalidConnectFailed).toBe(true);

    const validSync = new InboundSync(validImapClient, db, validAccountId, testCapabilities);
    const result = await validSync.fullSync(validFolderId, "INBOX");

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBeGreaterThanOrEqual(1);

    const rows = await pgSql`
      SELECT subject FROM messages
      WHERE folder_id = ${validFolderId} AND deleted_at IS NULL
    `;

    const found = rows.find((r) => r.subject === uniqueSubject);
    expect(found).toBeDefined();
  });
});
