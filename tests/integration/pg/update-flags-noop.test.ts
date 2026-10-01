import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { updateFlags } from "../../../src/protocol/message-sync.js";
import { getDatabaseUrl } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";

/**
 * updateFlags() is what a stale CONDSTORE/QRESYNC modseq baseline (see change-detector.ts)
 * used to make PostIMAP call over and over with the exact same FlagChange for the exact
 * same message, every sync cycle, forever. These tests exercise the row-level guard added
 * against that: redelivering state the row already holds costs no write.
 *
 * `xmin` (Postgres's own per-tuple version counter) is the proof used here rather than
 * `updated_at` -- it advances on every physical UPDATE regardless of what wrote it or
 * whether any trigger ran, so it cannot be fooled by a trigger that happens to leave
 * updated_at alone.
 */

let pgSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
let accountId: string;
let folderId: string;
const imapUid = "100";

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
    VALUES (${accountId}, ${`update-flags-noop-${randomUUID().slice(0, 8)}`}, '127.0.0.1', 11143,
      'test@test.local', ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, from_addr)
    VALUES (${randomUUID()}, ${accountId}, ${folderId}, ${imapUid}, 'Test Subject', 'from@test.local')
  `;
});

async function readRow(): Promise<{ xmin: string; is_seen: boolean; modseq: string | null }> {
  const rows = await pgSql<{ xmin: string; is_seen: boolean; modseq: string | null }[]>`
    SELECT xmin::text, is_seen, modseq FROM messages
    WHERE folder_id = ${folderId} AND imap_uid = ${imapUid}
  `;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("updateFlags: redelivered state costs no write", () => {
  test("the exact same flags and modseq, delivered twice, rewrites the row only once", async () => {
    await updateFlags(db, folderId, [{ uid: 100, flags: new Set(["\\Seen"]), modseq: BigInt(5) }]);
    const afterFirst = await readRow();
    expect(afterFirst.is_seen).toBe(true);
    expect(afterFirst.modseq).toBe("5");

    await updateFlags(db, folderId, [{ uid: 100, flags: new Set(["\\Seen"]), modseq: BigInt(5) }]);
    const afterRepeat = await readRow();

    // Same tuple version -- Postgres never executed a second physical UPDATE.
    expect(afterRepeat.xmin).toBe(afterFirst.xmin);
    expect(afterRepeat.is_seen).toBe(true);
    expect(afterRepeat.modseq).toBe("5");
  });

  test("a modseq that advances still writes, even though the tracked flags did not change", async () => {
    // A flag this table doesn't track (e.g. \Recent) can bump a message's modseq on its
    // own -- that value feeds outbound's CONDSTORE UNCHANGEDSINCE guard (flag-sync.ts), so
    // it must never be left stale just because nothing we store changed.
    await updateFlags(db, folderId, [{ uid: 100, flags: new Set(["\\Seen"]), modseq: BigInt(5) }]);
    const afterFirst = await readRow();

    await updateFlags(db, folderId, [{ uid: 100, flags: new Set(["\\Seen"]), modseq: BigInt(6) }]);
    const afterAdvance = await readRow();

    expect(afterAdvance.xmin).not.toBe(afterFirst.xmin);
    expect(afterAdvance.modseq).toBe("6");
  });

  test("a genuine flag change always writes", async () => {
    await updateFlags(db, folderId, [{ uid: 100, flags: new Set(["\\Seen"]), modseq: BigInt(5) }]);
    const afterFirst = await readRow();

    await updateFlags(db, folderId, [
      { uid: 100, flags: new Set(["\\Seen", "\\Flagged"]), modseq: BigInt(5) },
    ]);
    const afterChange = await readRow();

    expect(afterChange.xmin).not.toBe(afterFirst.xmin);
    expect(afterChange.is_seen).toBe(true);
  });
});
