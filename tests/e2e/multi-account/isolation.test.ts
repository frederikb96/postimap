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
const NUM_ACCOUNTS = 3;
const suffix = randomUUID().slice(0, 8);

interface TestAccount {
  email: string;
  password: string;
  accountId: string;
  folderId: string;
  imapClient: ImapClient;
}

const accounts: TestAccount[] = [];

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;

beforeAll(async () => {
  pgSql = connectPg();
  schema = await createTestSchema(pgSql);
  db = createTestDb(getDatabaseUrl(schema));
  await pgSql.unsafe(`SET search_path TO "${schema}", public`);

  for (let i = 0; i < NUM_ACCOUNTS; i++) {
    const email = `e2e-iso-${suffix}-${i}@${env.TEST_DOMAIN}`;
    const password = `iso-pass-${i}-42`;
    const accountId = randomUUID();
    const folderId = randomUUID();

    await admin.createAccount(email, password);

    await pgSql`
      INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
        smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
      VALUES (
        ${accountId}, ${email}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
        ${email}, ${Buffer.from(password)},
        ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${email}, ${Buffer.from(password)},
        true, 'active'
      )
    `;

    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
    `;

    const imapClient = new ImapClient({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: email,
      password,
      tls: testTls,
      retry: { maxRetries: 0, baseDelay: 100 },
    });
    imapClient.on("error", () => {});
    await imapClient.connect();

    accounts.push({ email, password, accountId, folderId, imapClient });
  }
});

afterAll(async () => {
  for (const acct of accounts) {
    if (acct.imapClient.isConnected()) {
      await acct.imapClient.disconnect();
    }
    await admin.deleteAccount(acct.email);
  }
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

describe("E2E: multi-account isolation", () => {
  test("3 accounts sync simultaneously with no cross-contamination", async () => {
    const subjects: string[] = [];
    for (let i = 0; i < NUM_ACCOUNTS; i++) {
      const subject = `Isolation ${suffix} acct-${i}`;
      subjects.push(subject);

      const checkClient = await connectImap({
        user: accounts[i].email,
        password: accounts[i].password,
      });
      try {
        await deliverAndWait({
          from: accounts[i].email,
          to: accounts[i].email,
          subject,
          text: `Body for account ${i}`,
          auth: { user: accounts[i].email, pass: accounts[i].password },
          imapClient: checkClient,
        });
      } finally {
        await checkClient.logout();
      }
    }

    const syncPromises = accounts.map((acct) => {
      const inbound = new InboundSync(acct.imapClient, db, acct.accountId, testCapabilities);
      return inbound.fullSync(acct.folderId, "INBOX");
    });

    const results = await Promise.all(syncPromises);

    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(result.newMessages).toBeGreaterThanOrEqual(1);
    }

    await pgSql.unsafe(`SET search_path TO "${schema}", public`);

    for (let i = 0; i < NUM_ACCOUNTS; i++) {
      const rows = await pgSql`
        SELECT subject, account_id FROM messages
        WHERE folder_id = ${accounts[i].folderId} AND deleted_at IS NULL
      `;

      for (const row of rows) {
        expect(row.account_id).toBe(accounts[i].accountId);
      }

      const found = rows.find((r) => r.subject === subjects[i]);
      expect(found).toBeDefined();

      for (let j = 0; j < NUM_ACCOUNTS; j++) {
        if (j === i) continue;
        const cross = rows.find((r) => r.subject === subjects[j]);
        expect(cross).toBeUndefined();
      }
    }
  });
});
