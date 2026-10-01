import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import type { ServerCapabilities } from "../../../src/imap/capabilities.js";
import type { ImapClient } from "../../../src/imap/pool.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import { getDatabaseUrl } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  insertMirroredFolder,
  truncateAll,
} from "../../setup/pg-helpers.js";

/**
 * Simulates a server (Zoho in production) that advertises and ENABLEs CONDSTORE but
 * ignores CHANGEDSINCE entirely: every known message comes back on every FETCH, UID range
 * or CHANGEDSINCE modifier notwithstanding, and never carrying a MODSEQ at all. No real
 * IMAP server behaves this way, so this is a fake ImapClient rather than a Dovecot e2e --
 * the thing under test is InboundSync.syncFolder()'s reaction to
 * ChangeSet.changedSinceUnsupported, not the IMAP protocol itself.
 */
function buildBrokenCondstoreClient(knownUids: number[], flagsByUid: Map<number, Set<string>>) {
  const mailbox = {
    path: "INBOX",
    uidValidity: BigInt(1),
    uidNext: Math.max(...knownUids, 0) + 1,
    exists: knownUids.length,
    highestModseq: BigInt(1790852409189002200),
  };

  const fetchSpy = vi.fn(async function* fakeFetch() {
    for (const uid of knownUids) {
      yield { uid, flags: flagsByUid.get(uid) ?? new Set<string>(), modseq: undefined };
    }
  });
  const searchSpy = vi.fn(async () => knownUids);

  const flow = { mailbox, fetch: fetchSpy, search: searchSpy };
  const client = {
    get client() {
      return flow;
    },
    async getMailboxLock() {
      return { path: "INBOX", release: () => {} };
    },
    isConnected: () => true,
  } as unknown as ImapClient;

  return { client, fetchSpy, searchSpy };
}

let pgSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
let accountId: string;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

beforeEach(async () => {
  await truncateAll(pgSql);
  accountId = randomUUID();

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, ${`broken-condstore-${randomUUID().slice(0, 8)}`}, '127.0.0.1', 11143,
      'test@test.local', ${Buffer.from("pass")}, true, 'active')
  `;
});

async function insertFolder(folderId: string, imapName: string): Promise<void> {
  await insertMirroredFolder(
    pgSql,
    (tx) =>
      tx`
      INSERT INTO folders (id, account_id, imap_name, display_name, special_use, uidvalidity, uidnext, highestmodseq)
      VALUES (${folderId}, ${accountId}, ${imapName}, ${imapName}, NULL, '1', '3', '1790852409189002200')
    `,
  );
}

async function insertKnownMessage(folderId: string, uid: number, isSeen: boolean): Promise<void> {
  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, from_addr, is_seen, modseq)
    VALUES (${randomUUID()}, ${accountId}, ${folderId}, ${String(uid)}, 'Test Subject', 'from@test.local',
      ${isSeen}, NULL)
  `;
}

describe("InboundSync: a server whose CHANGEDSINCE responses never carry MODSEQ", () => {
  test("downgrades the account, reports zero false-positive flag changes, and clears the bogus baseline", async () => {
    const folderId = randomUUID();
    await insertFolder(folderId, "INBOX");
    // Every message's stored is_seen already matches what the fake server reports --
    // mirrors production, where the rows were correctly synced once and the server has
    // just been repeating itself ever since.
    await insertKnownMessage(folderId, 1, true);
    await insertKnownMessage(folderId, 2, false);

    const flagsByUid = new Map([
      [1, new Set(["\\Seen"])],
      [2, new Set<string>()],
    ]);
    const { client } = buildBrokenCondstoreClient([1, 2], flagsByUid);

    const capabilities: ServerCapabilities = {
      condstore: true,
      qresync: false,
      idle: false,
      move: false,
      uidplus: false,
      mailboxId: false,
    };
    const sync = new InboundSync(client, db, accountId, capabilities);

    const result = await sync.syncFolder(folderId, "INBOX");

    expect(result.errors).toEqual([]);
    // The fix under test: no message gets reported changed just because the broken server
    // returned it -- every row's stored flags already match reality.
    expect(result.updatedFlags).toBe(0);

    expect(capabilities.condstoreUnreliable).toBe(true);
    expect(capabilities.condstore).toBe(false);

    const accountRow = await pgSql`SELECT capabilities FROM accounts WHERE id = ${accountId}`;
    expect(accountRow[0].capabilities.condstoreUnreliable).toBe(true);

    const folderRow = await pgSql`SELECT highestmodseq FROM folders WHERE id = ${folderId}`;
    expect(folderRow[0].highestmodseq).toBeNull();
  });

  test("a genuine flag change is still detected correctly on the triggering cycle, and only it", async () => {
    const folderId = randomUUID();
    await insertFolder(folderId, "INBOX");
    // Row 1's stored flags are stale -- the server really did flag it \Seen since the last
    // sync -- and row 2's already match. The broken CHANGEDSINCE-trusting path would
    // report both; the full-diff fallback this cycle recurses into must report only 1.
    await insertKnownMessage(folderId, 1, false);
    await insertKnownMessage(folderId, 2, true);

    const { client } = buildBrokenCondstoreClient(
      [1, 2],
      new Map([
        [1, new Set(["\\Seen"])],
        [2, new Set(["\\Seen"])],
      ]),
    );

    const capabilities: ServerCapabilities = {
      condstore: true,
      qresync: false,
      idle: false,
      move: false,
      uidplus: false,
      mailboxId: false,
    };
    const sync = new InboundSync(client, db, accountId, capabilities);

    const result = await sync.syncFolder(folderId, "INBOX");

    expect(result.errors).toEqual([]);
    expect(result.updatedFlags).toBe(1);

    const row1 =
      await pgSql`SELECT is_seen FROM messages WHERE folder_id = ${folderId} AND imap_uid = '1'`;
    expect(row1[0].is_seen).toBe(true);
  });

  test("a second folder on the same account never attempts CONDSTORE again", async () => {
    const folder1 = randomUUID();
    const folder2 = randomUUID();
    await insertFolder(folder1, "INBOX");
    await insertFolder(folder2, "Archive");
    await insertKnownMessage(folder1, 1, true);
    await insertKnownMessage(folder2, 1, true);

    const flagsByUid = new Map([[1, new Set(["\\Seen"])]]);
    const { client, fetchSpy } = buildBrokenCondstoreClient([1], flagsByUid);

    const capabilities: ServerCapabilities = {
      condstore: true,
      qresync: false,
      idle: false,
      move: false,
      uidplus: false,
      mailboxId: false,
    };
    const sync = new InboundSync(client, db, accountId, capabilities);

    await sync.syncFolder(folder1, "INBOX");
    expect(capabilities.condstoreUnreliable).toBe(true);

    fetchSpy.mockClear();
    const result2 = await sync.syncFolder(folder2, "Archive");

    expect(result2.errors).toEqual([]);
    expect(result2.updatedFlags).toBe(0);
    // Exactly one FETCH for this folder (the full-diff tier's own), and it never carries
    // a changedSince option -- tier was "full" from the very first call, condstore was
    // never attempted again.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][2]).toBeUndefined();
  });
});
