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
let messageId: string;

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
  messageId = randomUUID();

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'trigger-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, from_addr)
    VALUES (${messageId}, ${accountId}, ${folderId}, '100', 'Test Subject', 'from@test.local')
  `;
});

/** Runs `fn` inside a transaction tagged as a sync-engine write, mirroring withSyncWriter. */
async function asSyncWriter(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await pgSql.begin(async (tx) => {
    await tx`SET LOCAL postimap.writer = 'sync'`;
    await fn(tx);
  });
}

describe("PG trigger: flag changes -> sync_queue", () => {
  test("UPDATE is_seen=true creates sync_queue entry with action=flag_add, flag=\\Seen", async () => {
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT action, payload, account_id, message_id
      FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("flag_add");
    expect(rows[0].payload).toEqual({ flag: "\\Seen" });
    expect(rows[0].account_id).toBe(accountId);
    expect(rows[0].message_id).toBe(messageId);
  });

  test("UPDATE is_seen=false creates flag_remove entry", async () => {
    // Set to true as the sync engine so it doesn't enqueue, then flip it as the app.
    await asSyncWriter(async (tx) => {
      await tx`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
    });

    await pgSql`UPDATE messages SET is_seen = false WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("flag_remove");
    expect(rows[0].payload).toEqual({ flag: "\\Seen" });
  });

  test("UPDATE is_flagged=true creates flag_add entry", async () => {
    await pgSql`UPDATE messages SET is_flagged = true WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("flag_add");
    expect(rows[0].payload).toEqual({ flag: "\\Flagged" });
  });

  test("multiple flags changed in one UPDATE creates one entry per flag", async () => {
    await pgSql`UPDATE messages SET is_seen = true, is_flagged = true WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${messageId}
      ORDER BY created_at
    `;

    expect(rows).toHaveLength(2);
    const actions = rows.map((r: { action: string; payload: { flag: string } }) => ({
      action: r.action,
      flag: r.payload.flag,
    }));
    expect(actions).toContainEqual({ action: "flag_add", flag: "\\Seen" });
    expect(actions).toContainEqual({ action: "flag_add", flag: "\\Flagged" });
  });
});

describe("PG trigger: writer GUC loop guard", () => {
  test("a write inside a transaction with postimap.writer='sync' does NOT enqueue", async () => {
    await asSyncWriter(async (tx) => {
      await tx`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
    });

    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(0);
  });

  test("a plain UPDATE with no marker DOES enqueue", async () => {
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;

    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(1);
  });

  test("SET LOCAL resets at COMMIT -- the next app write on the same connection still enqueues", async () => {
    await asSyncWriter(async (tx) => {
      await tx`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
    });
    // Same pgSql connection (or pool), no marker this time.
    await pgSql`UPDATE messages SET is_seen = false WHERE id = ${messageId}`;

    const rows = await pgSql`SELECT action FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("flag_remove");
  });

  test("a rolled-back sync-writer transaction leaves no residue on the connection", async () => {
    await pgSql
      .begin(async (tx) => {
        await tx`SET LOCAL postimap.writer = 'sync'`;
        await tx`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
        throw new Error("rollback");
      })
      .catch(() => {});

    // is_seen should still be false (rolled back); a plain write flipping it must still
    // enqueue -- if the marker had leaked past the rollback, this would be silently lost.
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(1);
  });

  test("forgetting the marker on a sync-engine write fails safe (echo, not data loss)", async () => {
    // A sync write that forgot SET LOCAL still enqueues an outbound echo instead of
    // silently discarding the app's intent -- inbound reconciliation absorbs it.
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(1);
  });
});

describe("PG trigger: folder_id change -> sync_queue MOVE", () => {
  test("UPDATE folder_id creates a MOVE entry carrying the old folder and old imap_uid", async () => {
    const newFolderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${newFolderId}, ${accountId}, 'Archive', 'Archive')
    `;

    await pgSql`UPDATE messages SET folder_id = ${newFolderId} WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("move");
    expect(rows[0].payload).toEqual({
      from_folder_id: folderId,
      to_folder_id: newFolderId,
      old_imap_uid: "100",
    });
  });

  test("optimistic move: app sets imap_uid NULL alongside folder_id, old_imap_uid is still captured", async () => {
    const newFolderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${newFolderId}, ${accountId}, 'Archive', 'Archive')
    `;

    await pgSql`
      UPDATE messages SET folder_id = ${newFolderId}, imap_uid = NULL WHERE id = ${messageId}
    `;

    const rows = await pgSql`
      SELECT payload FROM sync_queue WHERE message_id = ${messageId} AND action = 'move'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.old_imap_uid).toBe("100");

    // NULL never collides under the unique constraint -- a second pending move into the
    // same folder must not violate (folder_id, imap_uid) uniqueness.
    const messageId2 = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid)
      VALUES (${messageId2}, ${accountId}, ${folderId}, '101')
    `;
    await expect(
      pgSql`UPDATE messages SET folder_id = ${newFolderId}, imap_uid = NULL WHERE id = ${messageId2}`,
    ).resolves.toBeDefined();
  });

  test("folder_id change inside a sync-writer transaction does NOT enqueue", async () => {
    const newFolderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${newFolderId}, ${accountId}, 'Sent', 'Sent')
    `;

    await asSyncWriter(async (tx) => {
      await tx`UPDATE messages SET folder_id = ${newFolderId} WHERE id = ${messageId}`;
    });

    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(0);
  });
});

describe("PG trigger: expunge -> sync_queue DELETE", () => {
  test("UPDATE expunged_at creates a DELETE entry with imap_uid and folder_id", async () => {
    await pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("delete");
    expect(rows[0].payload).toEqual({
      imap_uid: "100",
      folder_id: folderId,
    });
  });

  test("expunge inside a sync-writer transaction does NOT enqueue", async () => {
    await asSyncWriter(async (tx) => {
      await tx`UPDATE messages SET expunged_at = now() WHERE id = ${messageId}`;
    });

    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(0);
  });
});

interface FolderCounts {
  total_count: number;
  unread_count: number;
}

async function folderCounts(id: string): Promise<FolderCounts> {
  const rows = await pgSql<
    FolderCounts[]
  >`SELECT total_count, unread_count FROM folders WHERE id = ${id}`;
  return rows[0];
}

async function realCounts(id: string): Promise<FolderCounts> {
  const rows = await pgSql<{ total_count: number; unread_count: number }[]>`
    SELECT
      count(*) FILTER (WHERE expunged_at IS NULL)::int AS total_count,
      count(*) FILTER (WHERE expunged_at IS NULL AND NOT is_seen)::int AS unread_count
    FROM messages WHERE folder_id = ${id}
  `;
  return rows[0];
}

async function expectCountsMatch(id: string): Promise<void> {
  expect(await folderCounts(id)).toEqual(await realCounts(id));
}

describe("PG trigger: folder counters (delta formulation)", () => {
  let folderA: string;
  let folderB: string;
  let m1: string;
  let m2: string;
  let m3: string;

  beforeEach(async () => {
    folderA = randomUUID();
    folderB = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name) VALUES
        (${folderA}, ${accountId}, 'A'), (${folderB}, ${accountId}, 'B')
    `;

    m1 = randomUUID();
    m2 = randomUUID();
    m3 = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, is_seen) VALUES
        (${m1}, ${accountId}, ${folderA}, '1', false),
        (${m2}, ${accountId}, ${folderA}, '2', false),
        (${m3}, ${accountId}, ${folderA}, '3', true)
    `;
    await expectCountsMatch(folderA);
  });

  test("insert: total=3, unread=2", async () => {
    const counts = await folderCounts(folderA);
    expect(counts).toEqual({ total_count: 3, unread_count: 2 });
  });

  test("move + mark-seen in a single UPDATE", async () => {
    await pgSql`UPDATE messages SET folder_id = ${folderB}, is_seen = true WHERE id = ${m1}`;
    await expectCountsMatch(folderA);
    await expectCountsMatch(folderB);
  });

  test("expunge", async () => {
    await pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${m2}`;
    await expectCountsMatch(folderA);
  });

  test("un-expunge (the case the ELSIF-chain trigger got wrong)", async () => {
    await pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${m2}`;
    await pgSql`UPDATE messages SET expunged_at = NULL WHERE id = ${m2}`;
    await expectCountsMatch(folderA);
  });

  test("expunge + move + mark-seen in a single UPDATE", async () => {
    await pgSql`
      UPDATE messages SET expunged_at = now(), folder_id = ${folderB}, is_seen = true
      WHERE id = ${m2}
    `;
    await expectCountsMatch(folderA);
    await expectCountsMatch(folderB);
  });

  test("un-expunge back into a different folder while flipping unseen", async () => {
    await pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${m2}`;
    await pgSql`
      UPDATE messages SET expunged_at = NULL, folder_id = ${folderB}, is_seen = false
      WHERE id = ${m2}
    `;
    await expectCountsMatch(folderA);
    await expectCountsMatch(folderB);
  });

  test("hard DELETE of a visible row", async () => {
    await pgSql`DELETE FROM messages WHERE id = ${m3}`;
    await expectCountsMatch(folderA);
  });

  test("hard DELETE of an already-expunged row must not double-decrement", async () => {
    await pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${m1}`;
    await expectCountsMatch(folderA);
    await pgSql`DELETE FROM messages WHERE id = ${m1}`;
    await expectCountsMatch(folderA);
  });
});
