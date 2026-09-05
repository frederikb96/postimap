import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * `search_vector` never covered `to_addrs`, and carried no weight labels -- every lexeme
 * landed at Postgres's default weight class, so `ts_rank()` had no signal about whether a
 * match came from `subject` or `body_text`. Measured directly (a synthetic message with
 * "quarterly" once in its subject against one with "quarterly" five times in its body):
 * the body hit outranked the subject hit under the old, unweighted column -- the wrong
 * answer for what "relevance" should mean in a mail search.
 *
 * This redefines the generated column to add `to_addrs` and `setweight()`-label each
 * component -- A for subject, B for sender, C for recipient, D for body, Postgres's own
 * conventional letter-to-field mapping. `ts_rank()`'s *default* weight array is already
 * `{D: 0.1, C: 0.2, B: 0.4, A: 1.0}` -- exactly the subject > sender > recipient > body
 * priority order wanted here -- so every existing unweighted `ts_rank()` call downstream
 * starts ranking correctly with no consumer-side code change at all. `cc_addrs`/
 * `bcc_addrs` are deliberately left out: nothing reads them today, and speculative width
 * on a generated column is the expensive kind of speculation -- see the rewrite cost note
 * below.
 *
 * `to_addrs` is jsonb, cast to text before feeding it to `to_tsvector`. Bounded to 1000
 * characters (double `from_addr`'s 500-character bound): a handful of "Name
 * <address>" recipients, JSON-serialized with their surrounding brackets/quotes/commas,
 * fits comfortably; a message with far more recipients than that is searchable on the
 * first several rather than losing the field entirely.
 *
 * This is a superset change, verified directly rather than assumed: every row that
 * matched a `subject`/`from_addr`/`body_text` query under the old column still matches
 * the identical query under the new one (adding a fourth concatenated field can only add
 * lexemes, never remove the ones already there), and `@@` matching is unaffected by
 * `setweight()` -- weight only feeds `ts_rank()`. A consumer written against the old
 * shape keeps working, unchanged, on the new one; it just also gains recipient matches
 * and better-ordered results. `postimap_info.contract_version` stays at 1 for exactly the
 * reason `022_dav_contract.ts` and `024_search_vector_bound.ts` already established for
 * this table: nothing an existing consumer already does can break.
 *
 * `idx_msg_search` is made partial on `WHERE expunged_at IS NULL` here too, matching
 * every other index this table carries and every query that reads it -- it was the one
 * exception, indexing expunged rows that sit in the table for up to
 * `retention.purge_expunged_after_days` (30 by default) for no query that will ever read
 * them.
 *
 * Two trigram indexes remain, over `subject` and `from_addr` only -- not `to_addrs`
 * (recipient is now served by the full-text index above, which is the better path once
 * it covers the field) and not `body_text` (body matching runs through the full-text
 * index too, thousands of times cheaper than an unbounded trigram/ILIKE scan). What these
 * two exist for is the one query shape still run against the *whole* table: a
 * typo-tolerant fallback fired only when the primary full-text stage returns nothing.
 * That fallback needs the `<%`/`%>` operator form specifically -- confirmed directly: `col
 * %> 'token'` and its commutator `'token' <% col` (the planner rewrites the second into
 * the first) both produce a Bitmap Index Scan; the semantically identical
 * `word_similarity(col, 'token') >= threshold`, compared with `>=`, does not, and runs a
 * sequential scan regardless of what indexes exist -- only `%>` has a registered strategy
 * against `gin_trgm_ops`.
 *
 * `pg_trgm` is installed explicitly into `public`, and every reference to its
 * `gin_trgm_ops` operator class below is schema-qualified as `public.gin_trgm_ops` -- this
 * repo's own test harness runs migrations with `search_path` set to only the isolated test
 * schema being migrated (see `getDatabaseUrl()`, `tests/setup/env.ts`), not `public` as
 * well, so an unqualified reference right after `CREATE EXTENSION` in the same migration
 * fails there with "operator class gin_trgm_ops does not exist for access method gin" --
 * the extension exists, just not on that connection's `search_path`. Schema-qualifying is
 * correct regardless of `search_path`, in a test schema or a normal deployment alike.
 *
 * All three changes touch the same generated column (or the table it lives on), so
 * bundling them here pays the full-table-and-index rewrite this migration needs once,
 * rather than once per change.
 */
const UP_EXPRESSION = sql`
  setweight(to_tsvector('simple', coalesce(left(subject, 2000), '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(left(from_addr, 500), '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(left(to_addrs::text, 1000), '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(left(body_text, 200000), '')), 'D')
`;

// The exact shape 024_search_vector_bound.ts left the column in -- restoring it is what
// undoes this migration's redefinition, nothing more.
const DOWN_EXPRESSION = sql`to_tsvector('simple',
  coalesce(left(subject, 2000), '') || ' ' ||
  coalesce(left(from_addr, 500), '') || ' ' ||
  coalesce(left(body_text, 200000), ''))`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_msg_search`.execute(db);
  await db.schema.alterTable("messages").dropColumn("search_vector").execute();

  await db.schema
    .alterTable("messages")
    .addColumn("search_vector", sql`tsvector`, (col) =>
      col.generatedAlwaysAs(UP_EXPRESSION).stored(),
    )
    .execute();

  await sql`
    CREATE INDEX idx_msg_search ON messages USING gin(search_vector)
      WHERE expunged_at IS NULL
  `.execute(db);

  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public`.execute(db);

  await sql`
    CREATE INDEX idx_msg_trgm_subject ON messages USING gin (subject public.gin_trgm_ops)
      WHERE expunged_at IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX idx_msg_trgm_from ON messages USING gin (from_addr public.gin_trgm_ops)
      WHERE expunged_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_msg_trgm_from`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_msg_trgm_subject`.execute(db);

  await sql`DROP INDEX idx_msg_search`.execute(db);
  await db.schema.alterTable("messages").dropColumn("search_vector").execute();

  await db.schema
    .alterTable("messages")
    .addColumn("search_vector", sql`tsvector`, (col) =>
      col.generatedAlwaysAs(DOWN_EXPRESSION).stored(),
    )
    .execute();

  await sql`CREATE INDEX idx_msg_search ON messages USING gin(search_vector)`.execute(db);
}
