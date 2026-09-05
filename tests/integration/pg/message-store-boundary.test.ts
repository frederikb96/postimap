import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { fetchAndStoreMessages } from "../../../src/protocol/message-sync.js";
import { getDatabaseUrl } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";

/**
 * Two shapes of message content that PostgreSQL cannot store as-is: a NUL byte anywhere in
 * the parsed text, and searchable text large enough to overflow to_tsvector's own byte cap.
 * Both are fixed at the boundary in `src/protocol/message-sync.ts` and `search_vector`'s
 * generated-column definition -- these tests reproduce the exact insert PostIMAP's inbound
 * sync path runs, against a real PostgreSQL, with no real IMAP server involved at all.
 */

let pgSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
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
    VALUES (${accountId}, ${`boundary-test-${randomUUID().slice(0, 8)}`}, '127.0.0.1', 11143,
      'test@test.local', ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;
});

/**
 * A minimal ImapFlow stand-in. `fetchAndStoreMessages` only ever calls `.fetch()` -- once for
 * the size probe when `maxMessageBytes` is set (not exercised here), once for the full FETCH
 * -- so this only needs to satisfy that one method for a fixed set of UIDs.
 */
function fakeImapClient(sources: Map<number, Buffer>): ImapFlow {
  return {
    async *fetch() {
      for (const [uid, source] of sources) {
        yield {
          seq: uid,
          uid,
          source,
          size: source.length,
          flags: new Set<string>(),
          internalDate: new Date(),
        };
      }
    },
  } as unknown as ImapFlow;
}

const NUL = String.fromCharCode(0);

describe("message-sync: storing content PostgreSQL previously refused", () => {
  test("a message with a NUL byte in its subject and body stores successfully, byte removed", async () => {
    const tag = randomUUID().slice(0, 8);
    const uid = 1;
    const raw = Buffer.from(
      "From: sender@test.local\r\n" +
        "To: recipient@test.local\r\n" +
        `Subject: Hello${NUL}World ${tag}\r\n` +
        `Date: ${new Date().toUTCString()}\r\n` +
        `Message-ID: <nul-${tag}@test.local>\r\n` +
        "MIME-Version: 1.0\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Transfer-Encoding: 8bit\r\n" +
        "\r\n" +
        `Body before${NUL}Body after ${tag}\r\n`,
      "utf8",
    );

    const client = fakeImapClient(new Map([[uid, raw]]));
    const stored = await fetchAndStoreMessages(client, db, accountId, folderId, [uid]);
    expect(stored).toBe(1);

    const rows = await pgSql`
      SELECT subject, body_text FROM messages
      WHERE folder_id = ${folderId} AND imap_uid = ${String(uid)}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).not.toContain(NUL);
    expect(rows[0].subject).toContain(`HelloWorld ${tag}`);
    expect(rows[0].body_text).not.toContain(NUL);
    expect(rows[0].body_text).toContain(`Body beforeBody after ${tag}`);
  });

  test("a message whose searchable text exceeds the tsvector limit stores successfully, with search still working on what fits", async () => {
    const uid = 2;
    // Distinct, umlaut-heavy short tokens so almost nothing dedups in the tsvector and the
    // byte length runs well ahead of the character count -- a cap calibrated only against
    // ASCII fixture data would pass this test's word density and still overflow in
    // production, which is exactly the failure mode being guarded against.
    const tokenCount = 400_000;
    const tokens: string[] = new Array(tokenCount);
    for (let i = 0; i < tokenCount; i++) {
      tokens[i] = `wört${i}`;
    }
    const earlyWord = "findableearlyword";
    const lateWord = "findablelateword";
    const bodyText = `${earlyWord} ${tokens.join(" ")} ${lateWord}`;

    const raw = Buffer.from(
      "From: sender@test.local\r\n" +
        "To: recipient@test.local\r\n" +
        "Subject: Oversized search vector test\r\n" +
        `Date: ${new Date().toUTCString()}\r\n` +
        `Message-ID: <oversized-${randomUUID()}@test.local>\r\n` +
        "MIME-Version: 1.0\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Transfer-Encoding: 8bit\r\n" +
        "\r\n" +
        `${bodyText}\r\n`,
      "utf8",
    );

    const client = fakeImapClient(new Map([[uid, raw]]));
    const stored = await fetchAndStoreMessages(client, db, accountId, folderId, [uid]);
    expect(stored).toBe(1);

    const rows = await pgSql`
      SELECT body_text FROM messages
      WHERE folder_id = ${folderId} AND imap_uid = ${String(uid)}
    `;
    expect(rows).toHaveLength(1);
    // The stored body is the full, untruncated text -- only the generated column's input is
    // bounded, never what's actually persisted.
    expect(rows[0].body_text).toContain(earlyWord);
    expect(rows[0].body_text).toContain(lateWord);

    const early = await pgSql`
      SELECT 1 FROM messages
      WHERE folder_id = ${folderId} AND search_vector @@ to_tsquery('simple', ${earlyWord})
    `;
    expect(early).toHaveLength(1);

    const late = await pgSql`
      SELECT 1 FROM messages
      WHERE folder_id = ${folderId} AND search_vector @@ to_tsquery('simple', ${lateWord})
    `;
    expect(late).toHaveLength(0);
  });
});
