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

// Container-internal listen port (toxiproxy binds to this inside the container)
const PROXY_LISTEN_PORT = 23001;
// Host-mapped port (may differ in testcontainers mode)
const PROXY_HOST_PORT = env.TOXIPROXY_SLOW_PORT;

// Check toxiproxy availability at module load (top-level await)
const toxiCtx = await createToxiproxyClient();
const toxiAvailable = toxiCtx.available;

const admin = new StalwartAdmin();
const suffix = randomUUID().slice(0, 8);
const testEmail = `chaos-slow-${suffix}@${env.TEST_DOMAIN}`;
const testPassword = "chaos-slow-pass-42";
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

  const directClient = await connectImap({ user: testEmail, password: testPassword });
  await appendBulkMessages(directClient, "INBOX", 10, ["\\Seen"]);
  await directClient.logout();
});

beforeEach(async () => {
  if (!toxiAvailable) return;

  proxy = await createImapProxy(
    toxiCtx.toxiproxy,
    `postimap-slow-${suffix}-${randomUUID().slice(0, 4)}`,
    PROXY_LISTEN_PORT,
  );
});

afterEach(async () => {
  if (!toxiAvailable || !proxy) return;
  try {
    await proxy.remove();
  } catch {
    // Already removed
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

describe("Chaos: slow IMAP responses", () => {
  test.skipIf(!toxiAvailable)(
    "sync completes without timeout errors under 500ms latency",
    async () => {
      await proxy.addToxic({
        type: "latency",
        name: "slow-downstream",
        toxicity: 1.0,
        attributes: { latency: 500, jitter: 50 },
        stream: "downstream",
      } as ICreateToxicBody);

      const proxyClient = new ImapClient({
        host: env.TOXIPROXY_HOST,
        port: PROXY_HOST_PORT,
        user: testEmail,
        password: testPassword,
        tls: testTls,
        retry: { maxRetries: 0, baseDelay: 100 },
      });
      proxyClient.on("error", () => {});

      try {
        await proxyClient.connect();

        const inbound = new InboundSync(proxyClient, db, accountId, testCapabilities);
        const result = await inbound.fullSync(folderId, "INBOX");

        expect(result.errors).toEqual([]);
        expect(result.newMessages).toBeGreaterThanOrEqual(10);
      } finally {
        try {
          await proxyClient.disconnect();
        } catch {
          // May already be disconnected
        }
      }
    },
  );
});
