import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import type { ICreateToxicBody, Toxic } from "toxiproxy-node-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../src/db/schema.js";
import { AccountSync } from "../../src/sync/account-sync.js";
import type { OutboundProcessor } from "../../src/sync/outbound.js";
import type { OutboxProcessor } from "../../src/sync/outbox.js";
import type { ToxiProxy } from "../setup/chaos-helpers.js";
import {
  connectPg,
  createImapProxy,
  createTestDb,
  createTestSchema,
  createToxiproxyClient,
  dropTestSchema,
  env,
  getDatabaseUrl,
} from "../setup/e2e-helpers.js";
import { MailServerAdmin } from "../setup/mailserver-admin.js";

// Same proxy as network-partition.test.ts -- these are the only two toxiproxy listen
// ports the container exposes, and chaos test files run sequentially in one fork, so
// reusing 21001 here is safe (this file's proxy is fully torn down before the next).
const PROXY_LISTEN_PORT = 21001;
const PROXY_HOST_PORT = env.TOXIPROXY_IMAP_PORT;

const toxiCtx = await createToxiproxyClient();

const admin = new MailServerAdmin();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let proxy: ToxiProxy;

/** Stands in for the shared OutboundProcessor -- this test only exercises start()/stop(). */
function stubOutboundProcessor(): OutboundProcessor {
  return {
    subscribeAccount: async () => {},
    unsubscribeAccount: async () => {},
  } as unknown as OutboundProcessor;
}

/** Stands in for the shared OutboxProcessor -- this test only exercises start()/stop(). */
function stubOutboxProcessor(): OutboxProcessor {
  return {
    subscribeAccount: async () => {},
    unsubscribeAccount: async () => {},
  } as unknown as OutboxProcessor;
}

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
});

beforeEach(async () => {
  proxy = await createImapProxy(
    toxiCtx.toxiproxy,
    `postimap-startup-fault-${randomUUID().slice(0, 8)}`,
    PROXY_LISTEN_PORT,
  );
});

afterEach(async () => {
  if (!proxy) return;
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
});

describe("Chaos: account startup fault injection", () => {
  test("IMAP connection dying during account startup transitions cleanly to error with a retry scheduled, no unhandled exceptions", async () => {
    const testEmail = `startup-fault-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
    await admin.createAccount(testEmail);

    const accountId = randomUUID();
    // Format-versioned credential (see docs/consumer-contract.md): 0x00 prefix = plaintext.
    const formattedPassword = Buffer.concat([Buffer.from([0x00]), Buffer.from(env.MAIL_PASSWORD)]);
    await pgSql`
        INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
        VALUES (${accountId}, ${testEmail}, ${env.TOXIPROXY_HOST}, ${PROXY_HOST_PORT},
          ${testEmail}, ${formattedPassword}, true, 'created')
      `;

    // Cuts every downstream byte shortly after the proxy accepts the connection --
    // long enough for connect()+login to usually finish, short enough to kill the
    // connection during folder discovery or the initial full sync that follows. This
    // reproduces the historical crash: log-and-continue past a dead connection used to
    // null-deref (capabilities, folder payloads) instead of aborting the account.
    const killToxic: Toxic<unknown> = await proxy.addToxic({
      type: "timeout",
      name: "kill-mid-startup",
      toxicity: 1.0,
      attributes: { timeout: 400 },
      stream: "downstream",
    } as ICreateToxicBody<{ timeout: number }>);

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    const accountSync = new AccountSync(
      accountId,
      db,
      {
        SYNC_INTERVAL_SECONDS: 300,
        IDLE_RESTART_SECONDS: 300,
        IMAP_TLS_REJECT_UNAUTHORIZED: false,
        IDLE_FOLDERS: ["INBOX"],
      },
      getDatabaseUrl(schema),
      stubOutboundProcessor(),
      stubOutboxProcessor(),
    );

    try {
      // start() must never throw or reject -- every failure path is caught internally.
      await expect(accountSync.start()).resolves.toBeUndefined();

      expect(accountSync.getState()).toBe("error");

      const row = await pgSql`SELECT state, state_error FROM accounts WHERE id = ${accountId}`;
      expect(row[0].state).toBe("error");
      expect(row[0].state_error).toBeTruthy();

      // Let the connection through again and let the account's own retry timer (a few
      // seconds out, exponential backoff) bring it back up on its own -- proving this
      // is a real scheduled retry, not just a failure that happened to be caught.
      await killToxic.remove();

      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const poll = setInterval(() => {
          if (accountSync.getState() === "active") {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - start > 30_000) {
            clearInterval(poll);
            reject(
              new Error(`Did not recover to 'active' in time (state=${accountSync.getState()})`),
            );
          }
        }, 300);
      });

      expect(accountSync.getState()).toBe("active");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await accountSync.stop();
      await admin.deleteAccount(testEmail);
    }
  }, 60_000);
});
