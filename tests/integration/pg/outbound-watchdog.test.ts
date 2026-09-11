import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import type { ServerCapabilities } from "../../../src/imap/capabilities.js";
import type { ImapClient } from "../../../src/imap/pool.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import { testCapabilities } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
  insertMirroredFolder,
} from "../../setup/pg-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

interface LogRecord {
  level: string;
  msg: string;
  obj: Record<string, unknown>;
}

const logged = vi.hoisted(() => [] as LogRecord[]);

// What the watchdog logs is part of the behaviour under test: warnings and errors from the
// outbound module are recorded, everything else passes through to the real logger.
vi.mock("../../../src/util/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/util/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      if (name !== "outbound-sync") return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "error" || prop === "warn") {
            return (obj: Record<string, unknown>, msg: string) => {
              logged.push({ level: prop, msg, obj });
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const POLL_MS = 100;
const STALL_MS = 1_000;

let pgSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
const processors: OutboundProcessor[] = [];

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
});

afterEach(async () => {
  for (const processor of processors) await processor.stop();
  processors.length = 0;
  logged.length = 0;
});

afterAll(async () => {
  await db?.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

function makeProcessor(
  getImapClient: (accountId: string) => ImapClient,
  getCapabilities: () => Promise<ServerCapabilities | null> = async () => testCapabilities,
): OutboundProcessor {
  const processor = new OutboundProcessor(
    db,
    getDatabaseUrl(schema),
    getImapClient,
    getCapabilities,
    POLL_MS,
    STALL_MS,
    5,
  );
  processors.push(processor);
  return processor;
}

/** Only what a flag STORE touches: the connection check, the mailbox lock and the STORE. */
function fakeImapClient(
  getMailboxLock: () => Promise<{ release: () => void }> = async () => ({ release: () => {} }),
): ImapClient {
  return {
    isConnected: () => true,
    getMailboxLock,
    client: { messageFlagsAdd: async () => true, messageFlagsRemove: async () => true },
  } as unknown as ImapClient;
}

async function createAccount(): Promise<{ accountId: string; folderId: string }> {
  const accountId = randomUUID();
  const folderId = randomUUID();
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, ${accountId}, '127.0.0.1', 1, ${`${accountId}@test.local`},
      ${Buffer.from([0x00])}, true, 'active')
  `;
  await insertMirroredFolder(
    pgSql,
    (tx) => tx`
      INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
    `,
  );
  return { accountId, folderId };
}

async function insertMessage(accountId: string, folderId: string, uid: number): Promise<string> {
  const id = randomUUID();
  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
    VALUES (${id}, ${accountId}, ${folderId}, ${String(uid)}, ${`Message ${uid}`})
  `;
  return id;
}

/** A consumer's flag write, which the trigger turns into one queued entry. */
async function flag(messageId: string, column: "is_seen" | "is_flagged"): Promise<string> {
  await pgSql`UPDATE messages SET ${pgSql(column)} = true WHERE id = ${messageId}`;
  const [row] = await pgSql<{ id: string }[]>`
    SELECT id FROM sync_queue WHERE message_id = ${messageId} ORDER BY id DESC LIMIT 1
  `;
  return String(row.id);
}

async function entry(id: string) {
  const [row] = await pgSql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM sync_queue WHERE id = ${id}
  `;
  return row;
}

async function hasStatus(id: string, status: string): Promise<boolean> {
  return (await entry(id)).status === status;
}

describe("OutboundProcessor watchdog", () => {
  test("a batch that never settles is abandoned, and the account keeps syncing", async () => {
    const { accountId, folderId } = await createAccount();
    const first = await insertMessage(accountId, folderId, 101);
    const second = await insertMessage(accountId, folderId, 102);
    // Different flags, so two groups in one batch: the first one is the one in flight.
    const stalled = await flag(first, "is_seen");
    const waiting = await flag(second, "is_flagged");

    let locks = 0;
    const client = fakeImapClient(async () => {
      locks++;
      if (locks === 1) return new Promise(() => {});
      return { release: () => {} };
    });
    const processor = makeProcessor(() => client);
    await processor.start();
    await processor.subscribeAccount(accountId);

    await waitFor(() => hasStatus(waiting, "completed"), { timeout: 10_000 });

    // The group in flight is never taken away from the batch that holds it.
    expect(await entry(stalled)).toMatchObject({ status: "processing", attempts: 0 });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "Outbound batch made no progress, abandoning it",
        obj: expect.objectContaining({ accountId, inFlight: [stalled], released: 1 }),
      }),
    );

    const later = await flag(second, "is_seen");
    await waitFor(() => hasStatus(later, "completed"), { timeout: 5_000 });
  });

  test("entries wait untouched until the account's IMAP connection exists, then apply", async () => {
    const { accountId, folderId } = await createAccount();
    const queued = await flag(await insertMessage(accountId, folderId, 201), "is_seen");

    let client: ImapClient | null = null;
    const processor = makeProcessor(
      (id) => {
        if (!client) throw new Error(`No ImapClient for account ${id}`);
        return client;
      },
      async () => (client ? testCapabilities : null),
    );
    await processor.start();

    // Two sweeps' worth: nothing may attempt the entry, and the wait must be reported.
    await new Promise((resolve) => setTimeout(resolve, STALL_MS * 2.5));
    expect(await entry(queued)).toMatchObject({ status: "pending", attempts: 0 });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "Outbound rows waiting for an account whose IMAP connection is down",
        obj: expect.objectContaining({ accountId, waiting: 1 }),
      }),
    );

    client = fakeImapClient();
    await processor.subscribeAccount(accountId);
    await waitFor(() => hasStatus(queued, "completed"), { timeout: 5_000 });
    expect(await entry(queued)).toMatchObject({ attempts: 0 });
  });

  test("a due entry that no wakeup reaches is picked up by the watchdog", async () => {
    const { accountId, folderId } = await createAccount();
    const client = fakeImapClient();
    const processor = makeProcessor(() => client);
    await processor.start();
    await processor.subscribeAccount(accountId);
    // Stands for a lost poll timer and a lost LISTEN at once.
    await processor.unsubscribeAccount(accountId);
    // Let the batch that subscribing started finish its empty claim.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const queued = await flag(await insertMessage(accountId, folderId, 301), "is_seen");

    await waitFor(() => hasStatus(queued, "completed"), { timeout: 10_000 });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "Outbound rows overdue on a connected account",
        obj: expect.objectContaining({ accountId, waiting: 1 }),
      }),
    );
  });

  test("a connection that goes away mid-batch fails the entry instead of stranding it", async () => {
    const { accountId, folderId } = await createAccount();
    const queued = await flag(await insertMessage(accountId, folderId, 401), "is_seen");

    let gone = false;
    const client = fakeImapClient();
    const processor = makeProcessor(
      (id) => {
        if (gone) throw new Error(`No ImapClient for account ${id}`);
        return client;
      },
      // Read after the entries are claimed and resolved, right before the IMAP step.
      async () => {
        gone = true;
        return testCapabilities;
      },
    );

    await processor.drain(accountId).catch(() => {});

    expect(await entry(queued)).toMatchObject({ status: "failed", attempts: 1 });
  });
});
