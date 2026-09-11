import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import type { ImapClient } from "../../../src/imap/pool.js";
import { OutboxProcessor } from "../../../src/sync/outbox.js";
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

// The watchdog's whole job is to be loud, so what it logs is part of the behaviour under
// test: warnings and errors from the outbox module are recorded, everything else passes
// through to the real logger.
vi.mock("../../../src/util/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/util/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      if (name !== "outbox") return real;
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
const processors: OutboxProcessor[] = [];

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

function makeProcessor(getImapClient: (accountId: string) => ImapClient): OutboxProcessor {
  const processor = new OutboxProcessor(
    db,
    getDatabaseUrl(schema),
    getImapClient,
    POLL_MS,
    STALL_MS,
    0,
  );
  processors.push(processor);
  return processor;
}

/** Only what the outbox touches: the connection check and APPEND. */
function fakeImapClient(append: () => Promise<unknown>): ImapClient {
  return { isConnected: () => true, client: { append } } as unknown as ImapClient;
}

const appendLands = () => fakeImapClient(async () => ({ destination: "Drafts" }));

async function createAccount(): Promise<string> {
  const accountId = randomUUID();
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, ${accountId}, '127.0.0.1', 1, ${`${accountId}@test.local`},
      ${Buffer.from([0x00])}, true, 'active')
  `;
  await insertMirroredFolder(
    pgSql,
    (tx) => tx`
      INSERT INTO folders (account_id, imap_name, display_name, special_use)
      VALUES (${accountId}, 'Drafts', 'Drafts', 'drafts')
    `,
  );
  return accountId;
}

async function insertDraft(accountId: string, subject: string): Promise<string> {
  const [row] = await pgSql<{ id: string }[]>`
    INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text)
    VALUES (${accountId}, 'draft', ${pgSql.json(["someone@test.local"])}, ${subject}, 'body')
    RETURNING id
  `;
  return row.id;
}

async function outboxRow(id: string) {
  const [row] = await pgSql<{ status: string; attempts: number; error: string | null }[]>`
    SELECT status, attempts, error FROM outbox WHERE id = ${id}
  `;
  return row;
}

async function hasStatus(id: string, status: string): Promise<boolean> {
  return (await outboxRow(id)).status === status;
}

describe("OutboxProcessor watchdog", () => {
  test("a batch that never settles is abandoned, and the account keeps sending", async () => {
    const accountId = await createAccount();
    // Separate statements, so created_at orders them and the first one is the one in flight.
    const stalled = await insertDraft(accountId, "stall-first");
    const second = await insertDraft(accountId, "stall-second");
    const third = await insertDraft(accountId, "stall-third");

    let appends = 0;
    const client = fakeImapClient(async () => {
      appends++;
      if (appends === 1) return new Promise(() => {});
      return { destination: "Drafts" };
    });
    const processor = makeProcessor(() => client);
    await processor.start();
    await processor.subscribeAccount(accountId);

    await waitFor(
      async () => (await hasStatus(second, "sent")) && (await hasStatus(third, "sent")),
      { timeout: 10_000 },
    );

    // The entry in flight is never taken away from the batch that holds it.
    expect(await outboxRow(stalled)).toMatchObject({ status: "processing", attempts: 0 });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "Outbox batch made no progress, abandoning it",
        obj: expect.objectContaining({ accountId, inFlight: [stalled], released: 2 }),
      }),
    );

    const later = await insertDraft(accountId, "stall-later");
    await waitFor(() => hasStatus(later, "sent"), { timeout: 5_000 });
  });

  test("a due row that no wakeup reaches is picked up by the watchdog", async () => {
    const accountId = await createAccount();
    const processor = makeProcessor(appendLands);
    await processor.start();
    await processor.subscribeAccount(accountId);
    // Stands for a lost poll timer and a lost LISTEN at once.
    await processor.unsubscribeAccount(accountId);
    // Let the batch that subscribing started finish its empty claim, so it cannot be what
    // picks the row up.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const draft = await insertDraft(accountId, "lost-wakeup");

    await waitFor(() => hasStatus(draft, "sent"), { timeout: 10_000 });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "Outbox rows overdue on a connected account",
        obj: expect.objectContaining({ accountId, waiting: 1 }),
      }),
    );
  });

  test("rows wait untouched until the account's IMAP connection exists, then send", async () => {
    const accountId = await createAccount();
    const draft = await insertDraft(accountId, "startup-race");

    let client: ImapClient | null = null;
    const processor = makeProcessor((id) => {
      if (!client) throw new Error(`No ImapClient for account ${id}`);
      return client;
    });
    await processor.start();

    // Two sweeps' worth: nothing may attempt the row, and the wait must be reported.
    await new Promise((resolve) => setTimeout(resolve, STALL_MS * 2.5));
    expect(await outboxRow(draft)).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "Outbox rows waiting for an account whose IMAP connection is down",
        obj: expect.objectContaining({ accountId, waiting: 1 }),
      }),
    );

    client = appendLands();
    await processor.subscribeAccount(accountId);
    await waitFor(() => hasStatus(draft, "sent"), { timeout: 5_000 });
    expect(await outboxRow(draft)).toMatchObject({ attempts: 0, error: null });
  });

  test("an APPEND that ImapFlow skips is retried, not recorded as a saved draft", async () => {
    const accountId = await createAccount();
    const draft = await insertDraft(accountId, "append-skipped");

    // ImapFlow resolves undefined when the connection is in no state to append.
    const processor = makeProcessor(() => fakeImapClient(async () => undefined));
    await processor.drain(accountId);

    expect(await outboxRow(draft)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: expect.stringContaining("not appended"),
    });
  });
});
