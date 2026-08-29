import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { purgeExpired, type RetentionConfig } from "../../../src/sync/retention.js";
import { SyncAbortedError } from "../../../src/util/abort.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
  truncateAll,
} from "../../setup/pg-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

interface PostimapEvent {
  type: string;
  op: string;
  id: string;
  account_id?: string;
  origin?: string;
}

let pgSql: postgres.Sql;
let listenerSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let accountId: string;

let events: PostimapEvent[];
let subscription: { unlisten: () => Promise<void> } | undefined;

const config: RetentionConfig = {
  purgeExpungedAfterDays: 30,
  purgeFoldersAfterDays: 7,
  auditDays: 90,
};

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  listenerSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (listenerSql) await listenerSql.end();
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
    VALUES (${accountId}, ${`retention-${randomUUID()}`}, '127.0.0.1', 993, 'test@test.local',
      ${Buffer.from([0x00, ...Buffer.from("pass")])}, true, 'active')
  `;

  events = [];
  subscription = await listenerSql.listen("postimap_events", (payload) => {
    events.push(JSON.parse(payload) as PostimapEvent);
  });
});

afterEach(async () => {
  await subscription?.unlisten();
});

describe("PG Integration: retention purge", () => {
  test("hard-deletes messages expunged past the window, keeps recently-expunged ones", async () => {
    const folderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
    `;

    const oldId = randomUUID();
    const recentId = randomUUID();
    const liveId = randomUUID();

    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, expunged_at)
      VALUES
        (${oldId}, ${accountId}, ${folderId}, '1', 'old expunged', ${daysAgo(31)}),
        (${recentId}, ${accountId}, ${folderId}, '2', 'recent expunged', ${daysAgo(1)}),
        (${liveId}, ${accountId}, ${folderId}, '3', 'still live', ${null})
    `;

    const result = await purgeExpired(db, config);
    expect(result.messagesDeleted).toBe(1);

    const remaining = await pgSql`
      SELECT id FROM messages WHERE account_id = ${accountId} ORDER BY id
    `;
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(oldId);
    expect(remainingIds).toContain(recentId);
    expect(remainingIds).toContain(liveId);
  });

  test("cascades to attachments when purging an expunged message", async () => {
    const folderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
    `;
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, expunged_at)
      VALUES (${messageId}, ${accountId}, ${folderId}, '1', 'old expunged', ${daysAgo(31)})
    `;
    await pgSql`
      INSERT INTO attachments (message_id, filename, data)
      VALUES (${messageId}, 'a.pdf', ${Buffer.from("x")})
    `;

    await purgeExpired(db, config);

    const attachments = await pgSql`SELECT id FROM attachments WHERE message_id = ${messageId}`;
    expect(attachments).toHaveLength(0);
  });

  test("hard-deletes folders tombstoned past the window, keeps recently-tombstoned ones", async () => {
    const oldFolderId = randomUUID();
    const recentFolderId = randomUUID();
    const liveFolderId = randomUUID();

    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name, deleted_at)
      VALUES
        (${oldFolderId}, ${accountId}, 'Old', 'Old', ${daysAgo(8)}),
        (${recentFolderId}, ${accountId}, 'Recent', 'Recent', ${daysAgo(1)}),
        (${liveFolderId}, ${accountId}, 'INBOX', 'Inbox', ${null})
    `;

    const result = await purgeExpired(db, config);
    expect(result.foldersDeleted).toBe(1);

    const remaining = await pgSql`SELECT id FROM folders WHERE account_id = ${accountId}`;
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(oldFolderId);
    expect(remainingIds).toContain(recentFolderId);
    expect(remainingIds).toContain(liveFolderId);
  });

  test("purges completed/dead sync_queue rows past the window, keeps pending and recent ones", async () => {
    const folderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
    `;

    await pgSql`
      INSERT INTO sync_queue (account_id, folder_id, action, status, payload, processed_at)
      VALUES
        (${accountId}, ${folderId}, 'flag_add', 'completed', '{"flag":"\\\\Seen"}', ${daysAgo(91)}),
        (${accountId}, ${folderId}, 'flag_add', 'dead', '{"flag":"\\\\Seen"}', ${daysAgo(91)}),
        (${accountId}, ${folderId}, 'flag_add', 'completed', '{"flag":"\\\\Seen"}', ${daysAgo(1)}),
        (${accountId}, ${folderId}, 'flag_add', 'pending', '{"flag":"\\\\Seen"}', ${null})
    `;

    const result = await purgeExpired(db, config);
    expect(result.queueDeleted).toBe(2);

    const remaining = await pgSql`
      SELECT status FROM sync_queue WHERE account_id = ${accountId} ORDER BY status
    `;
    expect(remaining.map((r) => r.status).sort()).toEqual(["completed", "pending"]);
  });

  test("purges old sync_audit rows, keeps recent ones", async () => {
    await pgSql`
      INSERT INTO sync_audit (account_id, direction, action, created_at)
      VALUES
        (${accountId}, 'inbound', 'insert', ${daysAgo(91)}),
        (${accountId}, 'inbound', 'insert', ${daysAgo(1)})
    `;

    const result = await purgeExpired(db, config);
    expect(result.auditDeleted).toBe(1);

    const remaining = await pgSql`SELECT id FROM sync_audit WHERE account_id = ${accountId}`;
    expect(remaining).toHaveLength(1);
  });

  test("paginates past a single batch (bulk expunged messages all get purged)", async () => {
    const folderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
    `;

    // More than the purge job's internal batch size (500), all expunged well past the window.
    const bulkCount = 620;
    await pgSql`
      INSERT INTO messages (account_id, folder_id, imap_uid, subject, expunged_at)
      SELECT ${accountId}, ${folderId}, gs::bigint, 'bulk-' || gs, ${daysAgo(31)}
      FROM generate_series(1, ${bulkCount}) AS gs
    `;

    const result = await purgeExpired(db, config);
    expect(result.messagesDeleted).toBe(bulkCount);

    const remaining = await pgSql`
      SELECT count(*)::int AS n FROM messages WHERE account_id = ${accountId}
    `;
    expect(remaining[0].n).toBe(0);
  }, 30_000);

  test("is interruptible: an already-aborted signal stops the purge before any deletion", async () => {
    const folderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
    `;
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, expunged_at)
      VALUES (${messageId}, ${accountId}, ${folderId}, '1', 'old expunged', ${daysAgo(31)})
    `;

    const controller = new AbortController();
    controller.abort();

    await expect(purgeExpired(db, config, controller.signal)).rejects.toThrow(SyncAbortedError);

    const remaining = await pgSql`SELECT id FROM messages WHERE id = ${messageId}`;
    expect(remaining).toHaveLength(1);
  });

  test("origin is reported as sync for the postimap_events delete of a purged message", async () => {
    const folderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
    `;
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, expunged_at)
      VALUES (${messageId}, ${accountId}, ${folderId}, '1', 'old expunged', ${daysAgo(31)})
    `;
    await purgeExpired(db, config);

    // Filtered by op, not just id: the INSERT above also fires a message event for this
    // same id (origin=app), and NOTIFY delivery to the listener is async relative to the
    // INSERT's own response -- clearing `events` between the two isn't reliably ordered.
    await waitFor(() =>
      events.some((e) => e.type === "message" && e.id === messageId && e.op === "delete"),
    );
    const event = events.find(
      (e) => e.type === "message" && e.id === messageId && e.op === "delete",
    );
    expect(event).toMatchObject({ type: "message", op: "delete", id: messageId, origin: "sync" });
  });
});
