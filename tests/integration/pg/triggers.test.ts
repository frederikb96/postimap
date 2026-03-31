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
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, from_addr, sync_version)
    VALUES (${messageId}, ${accountId}, ${folderId}, '100', 'Test Subject', 'from@test.local', '0')
  `;
});

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
    // First set to true without triggering (via sync_version bump)
    await pgSql`UPDATE messages SET is_seen = true, sync_version = sync_version::bigint + 1 WHERE id = ${messageId}`;
    await pgSql`DELETE FROM sync_queue WHERE message_id = ${messageId}`;

    // Now set to false without sync_version bump (simulates app-level change)
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
});

describe("PG trigger: loop guard — sync_version increment skips enqueue", () => {
  test("UPDATE with sync_version+1 does NOT create sync_queue entry", async () => {
    await pgSql`
      UPDATE messages SET is_seen = true, sync_version = sync_version::bigint + 1
      WHERE id = ${messageId}
    `;

    const rows = await pgSql`
      SELECT * FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(0);
  });

  test("UPDATE without sync_version change DOES create sync_queue entry", async () => {
    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;

    const rows = await pgSql`
      SELECT * FROM sync_queue WHERE message_id = ${messageId}
    `;

    expect(rows).toHaveLength(1);
  });
});

describe("PG trigger: folder_id change -> sync_queue MOVE", () => {
  test("UPDATE folder_id creates sync_queue MOVE entry with correct payload", async () => {
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
    });
  });

  test("folder_id change with sync_version bump does NOT enqueue", async () => {
    const newFolderId = randomUUID();
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name)
      VALUES (${newFolderId}, ${accountId}, 'Sent', 'Sent')
    `;

    await pgSql`
      UPDATE messages SET folder_id = ${newFolderId}, sync_version = sync_version::bigint + 1
      WHERE id = ${messageId}
    `;

    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(0);
  });
});

describe("PG trigger: soft delete -> sync_queue DELETE", () => {
  test("UPDATE deleted_at creates sync_queue DELETE entry with imap_uid and folder_id in payload", async () => {
    await pgSql`UPDATE messages SET deleted_at = now() WHERE id = ${messageId}`;

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

  test("soft delete with sync_version bump does NOT enqueue", async () => {
    await pgSql`
      UPDATE messages SET deleted_at = now(), sync_version = sync_version::bigint + 1
      WHERE id = ${messageId}
    `;

    const rows = await pgSql`SELECT * FROM sync_queue WHERE message_id = ${messageId}`;
    expect(rows).toHaveLength(0);
  });
});

describe("PG trigger: multiple flag changes in single UPDATE", () => {
  test("setting is_seen and is_flagged simultaneously creates TWO sync_queue entries", async () => {
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
