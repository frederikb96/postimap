import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * `messages.is_truncated`: set when a message exceeded `storage.max_message_bytes` at
 * fetch time. Its body, headers, `raw_source` and attachments were never fetched from
 * IMAP, so they stay NULL/empty rather than being buffered in memory just to be
 * discarded -- this is the read side of the bound that keeps one oversized message from
 * materializing its whole size (plus every attachment) in the sync process's memory.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("messages")
    .addColumn("is_truncated", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE messages DROP COLUMN IF EXISTS is_truncated`.execute(db);
}
