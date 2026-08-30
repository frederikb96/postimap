import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { invalidateFolderQueue } from "../../../src/sync/queue-resolution.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
  insertMirroredFolder,
  truncateAll,
} from "../../setup/pg-helpers.js";

let pgSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
let accountId: string;
let folderId: string;
let otherFolderId: string;

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
  folderId = randomUUID();
  otherFolderId = randomUUID();

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'queue-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await insertMirroredFolder(
    pgSql,
    (tx) => tx`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox'),
           (${otherFolderId}, ${accountId}, 'Archive', 'Archive', NULL)
  `,
  );
});

/**
 * Claims up to `limit` pending entries the same way OutboundProcessor.processBatch does:
 * SELECT ... FOR UPDATE SKIP LOCKED and the status='processing' mark in ONE transaction,
 * so the row lock covers both statements.
 */
async function claimBatch(sql: postgres.Sql, limit: number): Promise<{ id: string }[]> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      SELECT id FROM sync_queue
      WHERE account_id = ${accountId} AND status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r: { id: string }) => r.id);
    await tx`UPDATE sync_queue SET status = 'processing' WHERE id = ANY(${ids})`;
    return rows;
  });
}

describe("PG sync_queue: transactional claim under real concurrency", () => {
  test("two connections racing claimBatch never claim the same entry", async () => {
    const msgIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const msgId = randomUUID();
      msgIds.push(msgId);
      await pgSql`
        INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
        VALUES (${msgId}, ${accountId}, ${folderId}, ${String(100 + i)}, ${`Msg ${i}`})
      `;
      await pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;
    }

    const pending = await pgSql`
      SELECT id FROM sync_queue WHERE account_id = ${accountId} AND status = 'pending'
    `;
    expect(pending).toHaveLength(5);

    const conn1 = connectPg(schema);
    const conn2 = connectPg(schema);

    try {
      // Fire both claims concurrently -- each is now a single transaction covering both
      // the SELECT FOR UPDATE SKIP LOCKED and the status='processing' mark, matching
      // processBatch. Previously those were two autocommitted statements, so the lock
      // from the first was released before the second ran and this race was decorative.
      const [result1, result2] = await Promise.all([claimBatch(conn1, 3), claimBatch(conn2, 3)]);

      const ids1 = new Set(result1.map((r) => r.id));
      const ids2 = new Set(result2.map((r) => r.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }

      // Together they must claim exactly the 5 available entries, no more, no less.
      expect(ids1.size + ids2.size).toBe(5);

      const stillPending = await pgSql`
        SELECT id FROM sync_queue WHERE account_id = ${accountId} AND status = 'pending'
      `;
      expect(stillPending).toHaveLength(0);

      const processing = await pgSql`
        SELECT id FROM sync_queue WHERE account_id = ${accountId} AND status = 'processing'
      `;
      expect(processing).toHaveLength(5);
    } finally {
      await conn1.end();
      await conn2.end();
    }
  });

  test("a claimed entry is invisible to a second claim even without a race (status changed)", async () => {
    const msgId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid)
      VALUES (${msgId}, ${accountId}, ${folderId}, '200')
    `;
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;

    const first = await claimBatch(pgSql, 10);
    expect(first).toHaveLength(1);

    const second = await claimBatch(pgSql, 10);
    expect(second).toHaveLength(0);
  });
});

describe("PG sync_queue: entry lifecycle", () => {
  test("new entries have status=pending, attempts=0, and next_retry_at <= now()", async () => {
    const msgId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
      VALUES (${msgId}, ${accountId}, ${folderId}, '200', 'Lifecycle Test')
    `;
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;

    const rows = await pgSql`
      SELECT status, attempts, max_attempts, next_retry_at
      FROM sync_queue WHERE message_id = ${msgId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].max_attempts).toBe(5);
    expect(new Date(rows[0].next_retry_at).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("PG sync_queue: a renumbered folder invalidates what was queued against it", () => {
  test("operations whose source UID lived in the folder are dead-lettered with a reason", async () => {
    // A UIDVALIDITY change means the server reassigned UIDs, so a captured UID can now
    // name a different message. Applying one would act on mail the user never touched --
    // silently, and destructively for a move or a delete.
    const flagged = randomUUID();
    const moved = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject) VALUES
        (${flagged}, ${accountId}, ${folderId}, '10', 'Flag me'),
        (${moved}, ${accountId}, ${folderId}, '11', 'Move me')
    `;
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${flagged}`;
    await pgSql`
      UPDATE messages SET folder_id = ${otherFolderId}, imap_uid = NULL WHERE id = ${moved}
    `;

    const count = await invalidateFolderQueue(db, folderId);
    expect(count).toBe(2);

    const rows = await pgSql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM sync_queue WHERE account_id = ${accountId}
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("dead");
      expect(row.error).toContain("UIDVALIDITY");
    }
  });

  test("a move INTO the renumbered folder is left alone", async () => {
    // Its source UID lives in another folder, which the renumbering did not touch.
    const incoming = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
      VALUES (${incoming}, ${accountId}, ${otherFolderId}, '30', 'Incoming')
    `;
    await pgSql`
      UPDATE messages SET folder_id = ${folderId}, imap_uid = NULL WHERE id = ${incoming}
    `;

    const count = await invalidateFolderQueue(db, folderId);
    expect(count).toBe(0);

    const [row] = await pgSql<{ status: string }[]>`
      SELECT status FROM sync_queue WHERE message_id = ${incoming}
    `;
    expect(row.status).toBe("pending");
  });

  test("an entry that has already finished is not resurrected as dead", async () => {
    const done = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
      VALUES (${done}, ${accountId}, ${folderId}, '40', 'Already done')
    `;
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${done}`;
    await pgSql`UPDATE sync_queue SET status = 'completed' WHERE message_id = ${done}`;

    expect(await invalidateFolderQueue(db, folderId)).toBe(0);

    const [row] = await pgSql<{ status: string }[]>`
      SELECT status FROM sync_queue WHERE message_id = ${done}
    `;
    expect(row.status).toBe("completed");
  });
});
