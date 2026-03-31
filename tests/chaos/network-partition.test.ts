import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import type { ICreateToxicBody } from "toxiproxy-node-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../src/db/schema.js";
import { ImapClient } from "../../src/imap/pool.js";
import { InboundSync } from "../../src/sync/inbound.js";
import type { ToxiProxy } from "../setup/chaos-helpers.js";
import {
  StalwartAdmin,
  appendBulkMessages,
  connectImap,
  connectPg,
  createImapProxy,
  createTestDb,
  createTestSchema,
  createToxiproxyClient,
  dropTestSchema,
  env,
  getDatabaseUrl,
  testCapabilities,
  testTls,
} from "../setup/e2e-helpers.js";

const PROXY_PORT = 21001;

// Check toxiproxy availability at module load (top-level await)
const toxiCtx = await createToxiproxyClient();
const toxiAvailable = toxiCtx.available;

const admin = new StalwartAdmin();
const suffix = randomUUID().slice(0, 8);
const testEmail = `chaos-net-${suffix}@${env.TEST_DOMAIN}`;
const testPassword = "chaos-net-pass-42";
const accountId = randomUUID();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let proxy: ToxiProxy;

const folderId = randomUUID();

beforeAll(async () => {
  if (!toxiAvailable) return;

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
      true, 'active'
    )
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;
});

beforeEach(async () => {
  if (!toxiAvailable) return;

  proxy = await createImapProxy(
    toxiCtx.toxiproxy,
    `postimap-imap-${suffix}-${randomUUID().slice(0, 4)}`,
    PROXY_PORT,
  );
});

afterEach(async () => {
  if (!toxiAvailable || !proxy) return;
  try {
    await proxy.remove();
  } catch {
    // Proxy may already be removed
  }
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
  if (toxiAvailable) {
    await admin.deleteAccount(testEmail);
  }
});

describe("Chaos: network partition", () => {
  test.skipIf(!toxiAvailable)(
    "IMAP disconnect during sync triggers error, subsequent sync recovers",
    async () => {
      const directClient = await connectImap({ user: testEmail, password: testPassword });
      await appendBulkMessages(directClient, "INBOX", 5, ["\\Seen"]);
      await directClient.logout();

      const proxyClient = new ImapClient({
        host: env.TOXIPROXY_HOST,
        port: PROXY_PORT,
        user: testEmail,
        password: testPassword,
        tls: testTls,
        retry: { maxRetries: 0, baseDelay: 100 },
      });
      proxyClient.on("error", () => {});

      try {
        await proxyClient.connect();

        await proxy.addToxic({
          type: "timeout",
          name: "kill-connection",
          toxicity: 1.0,
          attributes: { timeout: 100 },
          stream: "downstream",
        } as ICreateToxicBody);

        const inbound = new InboundSync(proxyClient, db, accountId, testCapabilities);
        const result = await inbound.fullSync(folderId, "INBOX");

        const hadError = result.errors.length > 0 || result.newMessages === 0;
        expect(hadError).toBe(true);
      } finally {
        try {
          await proxyClient.disconnect();
        } catch {
          // May already be disconnected
        }
      }

      // Remove all toxics before recovery
      await proxy.refreshToxics();
      for (const toxic of proxy.toxics) {
        await toxic.remove();
      }

      const recoveryClient = new ImapClient({
        host: env.IMAP_HOST,
        port: env.IMAP_PORT,
        user: testEmail,
        password: testPassword,
        tls: testTls,
        retry: { maxRetries: 0, baseDelay: 100 },
      });
      recoveryClient.on("error", () => {});

      try {
        await recoveryClient.connect();

        const inbound2 = new InboundSync(recoveryClient, db, accountId, testCapabilities);
        const recoveryResult = await inbound2.fullSync(folderId, "INBOX");

        expect(recoveryResult.errors).toEqual([]);
        expect(recoveryResult.newMessages).toBeGreaterThanOrEqual(5);
      } finally {
        try {
          await recoveryClient.disconnect();
        } catch {
          // May already be disconnected
        }
      }
    },
  );
});
