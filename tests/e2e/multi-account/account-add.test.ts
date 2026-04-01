import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { Orchestrator } from "../../../src/sync/orchestrator.js";
import {
  StalwartAdmin,
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  env,
  getDatabaseUrl,
  waitFor,
} from "../../setup/e2e-helpers.js";

const admin = new StalwartAdmin();
const suffix = randomUUID().slice(0, 8);

const existingEmail = `e2e-add-exist-${suffix}@${env.TEST_DOMAIN}`;
const existingPassword = "add-exist-pass-42";
const existingAccountId = randomUUID();

const newEmail = `e2e-add-new-${suffix}@${env.TEST_DOMAIN}`;
const newPassword = "add-new-pass-42";
const newAccountId = randomUUID();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let orchestrator: Orchestrator;

beforeAll(async () => {
  await admin.createAccount(existingEmail, existingPassword);
  await admin.createAccount(newEmail, newPassword);

  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (
      ${existingAccountId}, ${existingEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${existingEmail}, ${Buffer.from(existingPassword)},
      ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${existingEmail}, ${Buffer.from(existingPassword)},
      true, 'created'
    )
  `;
});

afterAll(async () => {
  if (orchestrator) {
    await Promise.race([orchestrator.stop(), new Promise<void>((r) => setTimeout(r, 15_000))]);
  }
  if (db) {
    await Promise.race([db.destroy(), new Promise<void>((r) => setTimeout(r, 5_000))]);
  }
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema).catch(() => {});
    await pgSql.end({ timeout: 5 });
  }
  await admin.deleteAccount(existingEmail).catch(() => {});
  await admin.deleteAccount(newEmail).catch(() => {});
}, 30_000);

describe("E2E: dynamic account addition", () => {
  test("INSERT new account into PG while orchestrator is running, detected via NOTIFY", async () => {
    orchestrator = new Orchestrator(
      db,
      {
        SYNC_INTERVAL_SECONDS: 300,
        IDLE_RESTART_SECONDS: 300,
        OUTBOUND_POLL_SECONDS: 300,
        MAX_RETRY_ATTEMPTS: 3,
        IMAP_TLS_REJECT_UNAUTHORIZED: false,
      },
      getDatabaseUrl(schema),
    );

    await orchestrator.start();

    await waitFor(
      () => {
        const status = orchestrator.getStatus();
        const acct = status.accounts.find((a) => a.accountId === existingAccountId);
        return acct && (acct.state === "active" || acct.state === "syncing");
      },
      { timeout: 30_000, interval: 500 },
    );

    const statusBefore = orchestrator.getStatus();
    expect(statusBefore.accounts).toHaveLength(1);

    // INSERT new account into PG (trigger fires account_changes NOTIFY automatically)
    await pgSql`
      INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
        smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
      VALUES (
        ${newAccountId}, ${newEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
        ${newEmail}, ${Buffer.from(newPassword)},
        ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${newEmail}, ${Buffer.from(newPassword)},
        true, 'created'
      )
    `;

    await waitFor(
      () => {
        const status = orchestrator.getStatus();
        const acct = status.accounts.find((a) => a.accountId === newAccountId);
        return acct !== undefined;
      },
      { timeout: 30_000, interval: 500 },
    );

    const statusAfter = orchestrator.getStatus();
    expect(statusAfter.accounts).toHaveLength(2);
    expect(statusAfter.accounts.find((a) => a.accountId === newAccountId)).toBeDefined();
  });
});
