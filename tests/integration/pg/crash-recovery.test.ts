import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { startupRecovery } from "../../../src/sync/startup.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
} from "../../setup/e2e-helpers.js";

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;

const accountId = randomUUID();
const folderId = randomUUID();

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'crash-test', '127.0.0.1', 993, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
  `;
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

describe("PG Integration: crash recovery", () => {
  test("startupRecovery resets all processing entries to pending", async () => {
    const processingIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const rows = await pgSql`
        INSERT INTO sync_queue (account_id, folder_id, action, status, payload)
        VALUES (${accountId}, ${folderId}, 'flag_add', 'processing', '{"flag":"\\\\Seen"}')
        RETURNING id
      `;
      processingIds.push(String(rows[0].id));
    }

    const pendingRows = await pgSql`
      INSERT INTO sync_queue (account_id, folder_id, action, status, payload)
      VALUES (${accountId}, ${folderId}, 'flag_add', 'pending', '{"flag":"\\\\Flagged"}')
      RETURNING id
    `;
    const pendingId = String(pendingRows[0].id);

    const completedRows = await pgSql`
      INSERT INTO sync_queue (account_id, folder_id, action, status, payload, processed_at)
      VALUES (${accountId}, ${folderId}, 'flag_remove', 'completed',
        '{"flag":"\\\\Draft"}', now())
      RETURNING id
    `;
    const completedId = String(completedRows[0].id);

    const beforeRows = await pgSql`
      SELECT id, status FROM sync_queue WHERE status = 'processing'
    `;
    expect(beforeRows).toHaveLength(3);

    await startupRecovery(db);

    for (const id of processingIds) {
      const rows = await pgSql`
        SELECT status, error FROM sync_queue WHERE id = ${id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].error).toBe("Reset on startup (process restart)");
    }

    const afterPending = await pgSql`
      SELECT status FROM sync_queue WHERE id = ${pendingId}
    `;
    expect(afterPending[0].status).toBe("pending");

    const afterCompleted = await pgSql`
      SELECT status FROM sync_queue WHERE id = ${completedId}
    `;
    expect(afterCompleted[0].status).toBe("completed");
  });

  test("startupRecovery is idempotent when no processing entries exist", async () => {
    await pgSql`UPDATE sync_queue SET status = 'completed' WHERE status = 'processing'`;

    await startupRecovery(db);

    const rows = await pgSql`
      SELECT status FROM sync_queue WHERE status = 'processing'
    `;
    expect(rows).toHaveLength(0);
  });
});
