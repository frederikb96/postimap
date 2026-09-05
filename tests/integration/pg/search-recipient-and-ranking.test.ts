import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectPg,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";

/**
 * `search_vector` gained a recipient field and per-field weight labels -- see migration
 * 025. Verifies the three claims that make this a safe, non-breaking change: matching a
 * recipient-only term now succeeds where it used to fail, a subject match now outranks a
 * body match for the same term (the defect the weights fix), and `@@` matching for
 * subject/sender/body terms is completely unaffected by the weight labels -- a consumer
 * written against the old column shape keeps working, unchanged, on the new one.
 *
 * Also verifies `idx_msg_search` is partial (matching every other index on this table) and
 * that exactly two trigram indexes remain -- subject and sender, not recipient (now served
 * by the full-text index) and not body (served by it too).
 */

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
    INSERT INTO accounts (id, name, imap_host, imap_user, imap_password)
    VALUES (${accountId}, ${`search-test-${randomUUID().slice(0, 8)}`}, '127.0.0.1',
      'test@test.local', ${Buffer.from("pass")})
  `;
  await pgSql`
    INSERT INTO folders (id, account_id, imap_name) VALUES (${folderId}, ${accountId}, 'INBOX')
  `;
});

describe("PG Integration: search_vector recipient coverage and ranking", () => {
  test("a term appearing only in to_addrs now matches, and matching subject/from/body terms is unaffected", async () => {
    await pgSql`
      INSERT INTO messages (account_id, folder_id, imap_uid, subject, from_addr, to_addrs, body_text)
      VALUES
        (${accountId}, ${folderId}, 1, 'subject term alpha', 'Sender One <one@example.com>',
          '["Recipient Bravo <recipbravo@example.com>"]'::jsonb, 'ordinary body text'),
        (${accountId}, ${folderId}, 2, 'unrelated subject', 'Sender Two <two@example.com>',
          '["Someone Else <else@example.com>"]'::jsonb, 'body term alpha here')
    `;

    // Recipient-only term: neither row's subject/from/body mentions it.
    const recipientMatch = await pgSql`
      SELECT id FROM messages WHERE search_vector @@ to_tsquery('simple', 'bravo')
    `;
    expect(recipientMatch).toHaveLength(1);

    // A term shared by subject (row 1) and body (row 2): both still match, same as the
    // pre-recipient/pre-weight column would have -- adding a fourth field never removes a
    // match the concatenation already had.
    const alphaMatch = await pgSql`
      SELECT id FROM messages WHERE search_vector @@ to_tsquery('simple', 'alpha') ORDER BY id
    `;
    expect(alphaMatch).toHaveLength(2);
  });

  test("a subject match now outranks a body match for the same term", async () => {
    await pgSql`
      INSERT INTO messages (account_id, folder_id, imap_uid, subject, from_addr, body_text)
      VALUES
        (${accountId}, ${folderId}, 1, 'quarterly report attached', 'Alice <alice@example.com>',
          'please review the attached document'),
        (${accountId}, ${folderId}, 2, 'meeting notes', 'Carol <carol@example.com>',
          'quarterly quarterly quarterly quarterly quarterly numbers discussed at length')
    `;

    const rows = await pgSql<{ subject: string; rank: number }[]>`
      SELECT subject, ts_rank(search_vector, to_tsquery('simple', 'quarterly')) AS rank
      FROM messages
      WHERE search_vector @@ to_tsquery('simple', 'quarterly')
      ORDER BY rank DESC
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.subject).toBe("quarterly report attached");
  });

  test("idx_msg_search is partial on expunged_at, and exactly two trigram indexes remain", async () => {
    const rows = await pgSql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename = 'messages'
        AND (indexname = 'idx_msg_search' OR indexname LIKE 'idx_msg_trgm_%')
      ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname)).toEqual([
      "idx_msg_search",
      "idx_msg_trgm_from",
      "idx_msg_trgm_subject",
    ]);
    for (const row of rows) {
      expect(row.indexdef).toContain("expunged_at IS NULL");
    }
  });
});
