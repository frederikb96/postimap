import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { resolveThreadId } from "../../../src/protocol/threading.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
  truncateAll,
} from "../../setup/pg-helpers.js";

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let accountId: string;
let folderId: string;

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

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'threading-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;
});

async function insertMessage(messageId: string, threadId?: string): Promise<string> {
  const rows = threadId
    ? await pgSql`
        INSERT INTO messages (account_id, folder_id, imap_uid, message_id, thread_id)
        VALUES (${accountId}, ${folderId}, ${Math.floor(Math.random() * 1_000_000)},
          ${messageId}, ${threadId})
        RETURNING thread_id
      `
    : await pgSql`
        INSERT INTO messages (account_id, folder_id, imap_uid, message_id)
        VALUES (${accountId}, ${folderId}, ${Math.floor(Math.random() * 1_000_000)}, ${messageId})
        RETURNING thread_id
      `;
  return rows[0].thread_id;
}

describe("resolveThreadId", () => {
  test("no references or in_reply_to starts a new thread", async () => {
    const threadId = await db
      .transaction()
      .execute((trx) => resolveThreadId(trx, accountId, null, null));
    expect(threadId).toBeTruthy();

    const other = await db
      .transaction()
      .execute((trx) => resolveThreadId(trx, accountId, null, null));
    expect(other).not.toBe(threadId);
  });

  test("in_reply_to matching an existing message joins its thread", async () => {
    const parentThreadId = await insertMessage("<parent@test.local>");

    const threadId = await db
      .transaction()
      .execute((trx) => resolveThreadId(trx, accountId, null, "<parent@test.local>"));

    expect(threadId).toBe(parentThreadId);
  });

  test("resolves via whichever referenced ancestor is actually known, ignoring the rest", async () => {
    const parentThread = await insertMessage("<parent@test.local>");

    // <grandparent@test.local> was never synced -- only <parent@test.local> matches.
    const threadId = await db
      .transaction()
      .execute((trx) =>
        resolveThreadId(trx, accountId, ["<grandparent@test.local>", "<parent@test.local>"], null),
      );

    expect(threadId).toBe(parentThread);
  });

  test("no matching ancestor found in references or in_reply_to starts a new thread", async () => {
    await insertMessage("<unrelated@test.local>");

    const threadId = await db
      .transaction()
      .execute((trx) =>
        resolveThreadId(trx, accountId, ["<nowhere@test.local>"], "<also-nowhere@test.local>"),
      );

    const unrelatedRow = await pgSql`
      SELECT thread_id FROM messages WHERE message_id = '<unrelated@test.local>'
    `;
    expect(threadId).not.toBe(unrelatedRow[0].thread_id);
  });

  test("a different account's message with the same message_id is never matched", async () => {
    const otherAccountId = randomUUID();
    const otherFolderId = randomUUID();
    await pgSql`
      INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
      VALUES (${otherAccountId}, 'other-account', '127.0.0.1', 11143, 'other@test.local',
        ${Buffer.from("pass")}, true, 'active')
    `;
    await pgSql`
      INSERT INTO folders (id, account_id, imap_name) VALUES (${otherFolderId}, ${otherAccountId}, 'INBOX')
    `;
    await pgSql`
      INSERT INTO messages (account_id, folder_id, imap_uid, message_id)
      VALUES (${otherAccountId}, ${otherFolderId}, 1, '<shared-id@test.local>')
    `;

    const threadId = await db
      .transaction()
      .execute((trx) => resolveThreadId(trx, accountId, null, "<shared-id@test.local>"));

    const otherRow = await pgSql`
      SELECT thread_id FROM messages WHERE account_id = ${otherAccountId}
    `;
    expect(threadId).not.toBe(otherRow[0].thread_id);
  });

  test("a message bridging two existing threads merges them onto the older thread", async () => {
    const threadAId = await insertMessage("<a1@test.local>");
    // Ensure thread A is strictly older than thread B for a deterministic "adopt the older" check.
    await pgSql`UPDATE messages SET created_at = now() - interval '1 hour' WHERE message_id = '<a1@test.local>'`;

    const threadBId = await insertMessage("<b1@test.local>");
    expect(threadBId).not.toBe(threadAId);

    // A message referencing both threads' messages should merge B onto A (the older one).
    const canonical = await db
      .transaction()
      .execute((trx) =>
        resolveThreadId(trx, accountId, ["<a1@test.local>", "<b1@test.local>"], null),
      );

    expect(canonical).toBe(threadAId);

    const bRowAfterMerge = await pgSql`
      SELECT thread_id FROM messages WHERE message_id = '<b1@test.local>'
    `;
    expect(bRowAfterMerge[0].thread_id).toBe(threadAId);
  });
});
