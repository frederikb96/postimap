import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectPg,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";

let pgSql: postgres.Sql;
let schema: string;
let accountId: string;
let folderId: string;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
});

afterAll(async () => {
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

beforeEach(async () => {
  await truncateAll(pgSql);

  accountId = randomUUID();
  folderId = randomUUID();

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'queue-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;
});

describe("PG sync_queue: FOR UPDATE SKIP LOCKED concurrent processing", () => {
  test("two concurrent processors do not double-process the same entries", async () => {
    // Seed a message and trigger sync_queue entries
    const msgIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const msgId = randomUUID();
      msgIds.push(msgId);
      await pgSql`
        INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, sync_version)
        VALUES (${msgId}, ${accountId}, ${folderId}, ${String(100 + i)}, ${`Msg ${i}`}, '0')
      `;
      // Trigger flag change -> sync_queue entry
      await pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;
    }

    // Verify we have 5 pending entries
    const pending = await pgSql`
      SELECT id FROM sync_queue WHERE account_id = ${accountId} AND status = 'pending'
    `;
    expect(pending).toHaveLength(5);

    // Simulate two concurrent processors using FOR UPDATE SKIP LOCKED
    // Both transactions must be OPEN simultaneously for locks to interact
    const conn1 = connectPg(schema);
    const conn2 = connectPg(schema);

    try {
      // Synchronization barrier: conn2 waits until conn1 has acquired locks
      let conn1Ready!: () => void;
      const conn1ReadyPromise = new Promise<void>((r) => {
        conn1Ready = r;
      });

      const [result1, result2] = await Promise.all([
        conn1.begin(async (tx) => {
          const rows = await tx`
            SELECT sq.id FROM sync_queue sq
            WHERE sq.account_id = ${accountId} AND sq.status = 'pending'
            ORDER BY sq.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 3
          `;
          conn1Ready();
          // Hold locks while conn2 runs its query
          await new Promise((r) => setTimeout(r, 500));
          return rows;
        }),
        conn1ReadyPromise.then(() =>
          conn2.begin(async (tx) => {
            return await tx`
              SELECT sq.id FROM sync_queue sq
              WHERE sq.account_id = ${accountId} AND sq.status = 'pending'
              ORDER BY sq.created_at
              FOR UPDATE SKIP LOCKED
              LIMIT 3
            `;
          }),
        ),
      ]);

      // Verify no overlap
      const ids1 = new Set(result1.map((r: { id: string }) => r.id));
      const ids2 = new Set(result2.map((r: { id: string }) => r.id));

      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }

      // Processor 1 got 3, processor 2 got the remaining 2
      expect(result1).toHaveLength(3);
      expect(result2).toHaveLength(2);
    } finally {
      await conn1.end();
      await conn2.end();
    }
  });
});

describe("PG sync_queue: entry lifecycle", () => {
  test("new entries have status=pending, attempts=0, and next_retry_at <= now()", async () => {
    const msgId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, sync_version)
      VALUES (${msgId}, ${accountId}, ${folderId}, '200', 'Lifecycle Test', '0')
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
