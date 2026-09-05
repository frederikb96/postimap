import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * `to_tsvector`'s own output is capped by PostgreSQL at just under 1MB (1,048,575 bytes) --
 * an unbounded `body_text` can produce a larger tsvector than that and abort the whole
 * insert. The generated column's input is bounded instead of the stored body, so a message
 * too large to search in full still stores untouched and is searchable on the part that
 * fits.
 *
 * Each cap below is a CHARACTER count applied through `left()`, which is encoding-aware and
 * never splits a multi-byte sequence -- unlike cutting a byte buffer at a fixed offset,
 * which can and does produce invalid UTF-8 at the boundary. The counts are sized for UTF-8's
 * worst case of 4 bytes per character, so the resulting input stays comfortably under the
 * limit whatever the mix of single- and multi-byte characters in the message.
 */
const UP_EXPRESSION = sql`to_tsvector('simple',
  coalesce(left(subject, 2000), '') || ' ' ||
  coalesce(left(from_addr, 500), '') || ' ' ||
  coalesce(left(body_text, 200000), ''))`;

const DOWN_EXPRESSION = sql`to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(from_addr, '') || ' ' || coalesce(body_text, ''))`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_msg_search`.execute(db);
  await db.schema.alterTable("messages").dropColumn("search_vector").execute();

  await db.schema
    .alterTable("messages")
    .addColumn("search_vector", sql`tsvector`, (col) =>
      col.generatedAlwaysAs(UP_EXPRESSION).stored(),
    )
    .execute();

  await sql`CREATE INDEX idx_msg_search ON messages USING gin(search_vector)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
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
