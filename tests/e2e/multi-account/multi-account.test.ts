import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encryptPassword } from "../../../src/crypto.js";
import type { Database } from "../../../src/db/schema.js";
import { ImapClient } from "../../../src/imap/pool.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import { Orchestrator } from "../../../src/sync/orchestrator.js";
import {
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
  waitFor,
} from "../../setup/e2e-helpers.js";
import { MailServerAdmin } from "../../setup/mailserver-admin.js";

const admin = new MailServerAdmin();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
const createdEmails: string[] = [];

/** Inserts a bare-bones account row into the shared test schema. */
async function insertAccount(email: string, password: string, state = "active"): Promise<string> {
  const accountId = randomUUID();
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, ${email}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${email}, ${encryptPassword(password)}, true, ${state})
  `;
  return accountId;
}

async function insertFolder(accountId: string, imapName = "INBOX"): Promise<string> {
  const folderId = randomUUID();
  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, ${imapName}, ${imapName}, ${imapName === "INBOX" ? "inbox" : null})
  `;
  return folderId;
}

const orchestratorConfig = {
  SYNC_INTERVAL_SECONDS: 300,
  IDLE_RESTART_SECONDS: 300,
  OUTBOUND_POLL_SECONDS: 300,
  MAX_RETRY_ATTEMPTS: 3,
  IMAP_TLS_REJECT_UNAUTHORIZED: false,
  IDLE_FOLDERS: ["INBOX"],
  RETENTION: {
    purgeExpungedAfterDays: 30,
    purgeFoldersAfterDays: 7,
    auditDays: 90,
  },
  // Long enough that no test run trips a real purge cycle -- retention itself is covered
  // in tests/integration/pg/retention.test.ts.
  RETENTION_INTERVAL_HOURS: 24,
};

beforeAll(async () => {
  pgSql = connectPg();
  schema = await createTestSchema(pgSql);
  db = createTestDb(getDatabaseUrl(schema));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema).catch(() => {});
    await pgSql.end({ timeout: 5 });
  }
  await Promise.all(createdEmails.map((email) => admin.deleteAccount(email)));
});

describe("E2E: multi-account", () => {
  test("INSERT new account into PG while orchestrator is running, detected via NOTIFY", async () => {
    const existingEmail = `e2e-add-exist-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
    const newEmail = `e2e-add-new-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
    createdEmails.push(existingEmail, newEmail);
    const existingAccountId = await insertAccount(existingEmail, env.MAIL_PASSWORD, "created");

    const orchestrator = new Orchestrator(db, orchestratorConfig, getDatabaseUrl(schema));
    try {
      await orchestrator.start();

      await waitFor(
        () => {
          const acct = orchestrator
            .getStatus()
            .accounts.find((a) => a.accountId === existingAccountId);
          return acct && (acct.state === "active" || acct.state === "syncing");
        },
        { timeout: 30_000, interval: 500 },
      );
      expect(orchestrator.getStatus().accounts).toHaveLength(1);

      // INSERT new account into PG (trigger fires postimap_events NOTIFY, type=account, automatically)
      const newAccountId = await insertAccount(newEmail, env.MAIL_PASSWORD, "created");

      await waitFor(
        () =>
          orchestrator.getStatus().accounts.find((a) => a.accountId === newAccountId) !== undefined,
        { timeout: 30_000, interval: 500 },
      );

      const statusAfter = orchestrator.getStatus();
      expect(statusAfter.accounts).toHaveLength(2);
      expect(statusAfter.accounts.find((a) => a.accountId === newAccountId)).toBeDefined();
    } finally {
      await Promise.race([orchestrator.stop(), new Promise<void>((r) => setTimeout(r, 15_000))]);
    }
  }, 60_000);

  test("UPDATE is_active=false stops sync and disconnects IMAP", async () => {
    const testEmail = `e2e-disable-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
    createdEmails.push(testEmail);
    const accountId = await insertAccount(testEmail, env.MAIL_PASSWORD, "created");

    const orchestrator = new Orchestrator(db, orchestratorConfig, getDatabaseUrl(schema));
    try {
      await orchestrator.start();

      await waitFor(
        () => {
          const acct = orchestrator.getStatus().accounts.find((a) => a.accountId === accountId);
          return acct && (acct.state === "active" || acct.state === "syncing");
        },
        { timeout: 30_000, interval: 500 },
      );

      // Trigger fires postimap_events NOTIFY (type=account) automatically via migration 004
      await pgSql`UPDATE accounts SET is_active = false WHERE id = ${accountId}`;

      await waitFor(
        () =>
          orchestrator.getStatus().accounts.find((a) => a.accountId === accountId) === undefined,
        { timeout: 30_000, interval: 500 },
      );

      expect(
        orchestrator.getStatus().accounts.find((a) => a.accountId === accountId),
      ).toBeUndefined();
    } finally {
      await Promise.race([orchestrator.stop(), new Promise<void>((r) => setTimeout(r, 15_000))]);
    }
  }, 60_000);

  test("invalid account credentials error while a valid account syncs normally", async () => {
    const suffix = randomUUID().slice(0, 8);
    const validEmail = `e2e-eriso-valid-${suffix}@${env.TEST_DOMAIN}`;
    createdEmails.push(validEmail);
    const validAccountId = await insertAccount(validEmail, env.MAIL_PASSWORD);
    const validFolderId = await insertFolder(validAccountId);

    // A PG account row with the wrong password: the mail server has no concept of
    // "unknown account" (any username authenticates against the shared password), so
    // a wrong password is what makes IMAP auth genuinely fail here.
    const invalidEmail = `e2e-eriso-invalid-${suffix}@${env.TEST_DOMAIN}`;
    await insertAccount(invalidEmail, "wrong-password-no-account");

    const validImapClient = new ImapClient({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: validEmail,
      password: env.MAIL_PASSWORD,
      tls: testTls,
      retry: { maxRetries: 0, baseDelay: 100 },
    });
    validImapClient.on("error", () => {});
    await validImapClient.connect();

    try {
      const uniqueSubject = `ErrorIso ${suffix}`;
      const checkClient = await connectImap({ user: validEmail, password: env.MAIL_PASSWORD });
      try {
        await deliverAndWait({
          from: validEmail,
          to: validEmail,
          subject: uniqueSubject,
          text: "Body for error isolation test.",
          imapClient: checkClient,
        });
      } finally {
        await checkClient.logout();
      }

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
        SELECT subject FROM messages WHERE folder_id = ${validFolderId} AND expunged_at IS NULL
      `;
      expect(rows.find((r) => r.subject === uniqueSubject)).toBeDefined();
    } finally {
      if (validImapClient.isConnected()) await validImapClient.disconnect();
    }
  });

  test("3 accounts sync simultaneously with no cross-contamination", async () => {
    const NUM_ACCOUNTS = 3;
    const suffix = randomUUID().slice(0, 8);
    const accounts: Array<{
      email: string;
      accountId: string;
      folderId: string;
      imapClient: ImapClient;
    }> = [];

    for (let i = 0; i < NUM_ACCOUNTS; i++) {
      const email = `e2e-iso-${suffix}-${i}@${env.TEST_DOMAIN}`;
      createdEmails.push(email);
      const accountId = await insertAccount(email, env.MAIL_PASSWORD);
      const folderId = await insertFolder(accountId);

      const imapClient = new ImapClient({
        host: env.IMAP_HOST,
        port: env.IMAP_PORT,
        user: email,
        password: env.MAIL_PASSWORD,
        tls: testTls,
        retry: { maxRetries: 0, baseDelay: 100 },
      });
      imapClient.on("error", () => {});
      await imapClient.connect();

      accounts.push({ email, accountId, folderId, imapClient });
    }

    try {
      const subjects: string[] = [];
      for (let i = 0; i < NUM_ACCOUNTS; i++) {
        const subject = `Isolation ${suffix} acct-${i}`;
        subjects.push(subject);

        const checkClient = await connectImap({
          user: accounts[i].email,
          password: env.MAIL_PASSWORD,
        });
        try {
          await deliverAndWait({
            from: accounts[i].email,
            to: accounts[i].email,
            subject,
            text: `Body for account ${i}`,
            imapClient: checkClient,
          });
        } finally {
          await checkClient.logout();
        }
      }

      const results = await Promise.all(
        accounts.map((acct) =>
          new InboundSync(acct.imapClient, db, acct.accountId, testCapabilities).fullSync(
            acct.folderId,
            "INBOX",
          ),
        ),
      );

      for (const result of results) {
        expect(result.errors).toEqual([]);
        expect(result.newMessages).toBeGreaterThanOrEqual(1);
      }

      for (let i = 0; i < NUM_ACCOUNTS; i++) {
        const rows = await pgSql`
          SELECT subject, account_id FROM messages
          WHERE folder_id = ${accounts[i].folderId} AND expunged_at IS NULL
        `;

        for (const row of rows) {
          expect(row.account_id).toBe(accounts[i].accountId);
        }

        expect(rows.find((r) => r.subject === subjects[i])).toBeDefined();

        for (let j = 0; j < NUM_ACCOUNTS; j++) {
          if (j === i) continue;
          expect(rows.find((r) => r.subject === subjects[j])).toBeUndefined();
        }
      }
    } finally {
      for (const acct of accounts) {
        if (acct.imapClient.isConnected()) await acct.imapClient.disconnect();
      }
    }
  });
});
