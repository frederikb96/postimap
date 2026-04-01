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

const testEmail = `e2e-disable-${suffix}@${env.TEST_DOMAIN}`;
const testPassword = "disable-pass-42";
const accountId = randomUUID();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let orchestrator: Orchestrator;

beforeAll(async () => {
  await admin.createAccount(testEmail, testPassword);

  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (
      ${accountId}, ${testEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${testEmail}, ${Buffer.from(testPassword)},
      ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${testEmail}, ${Buffer.from(testPassword)},
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
  await admin.deleteAccount(testEmail).catch(() => {});
});

describe("E2E: account disable", () => {
  test("UPDATE is_active=false stops sync and disconnects IMAP", async () => {
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
        const acct = status.accounts.find((a) => a.accountId === accountId);
        return acct && (acct.state === "active" || acct.state === "syncing");
      },
      { timeout: 30_000, interval: 500 },
    );

    const statusBefore = orchestrator.getStatus();
    const acctBefore = statusBefore.accounts.find((a) => a.accountId === accountId);
    expect(acctBefore).toBeDefined();
    expect(acctBefore?.state === "active" || acctBefore?.state === "syncing").toBe(true);

    // Trigger fires account_changes NOTIFY automatically via migration 004
    await pgSql`UPDATE accounts SET is_active = false WHERE id = ${accountId}`;

    await waitFor(
      () => {
        const status = orchestrator.getStatus();
        const acct = status.accounts.find((a) => a.accountId === accountId);
        return !acct;
      },
      { timeout: 30_000, interval: 500 },
    );

    const statusAfter = orchestrator.getStatus();
    const acctAfter = statusAfter.accounts.find((a) => a.accountId === accountId);
    expect(acctAfter).toBeUndefined();
  });
});
