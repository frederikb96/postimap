import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Editing a draft without accumulating a copy per save.
 *
 * A draft is an ordinary message once it has been appended, and `outbox` has no update
 * path -- composition is insert-only, deliberately, because a row that has already been
 * turned into bytes on a server cannot be edited by changing the row that produced it.
 * So an edit is a new draft plus the removal of the one it supersedes, and the only
 * question is who sequences those two halves. Left to the consumer it is two independent
 * operations with no ordering guarantee between them; named here it is one intent, and
 * PostIMAP appends before it removes, so an interruption costs a duplicate the user can
 * delete rather than the text they were writing.
 *
 * The removal goes onto `sync_queue` as an ordinary `delete`, which is what already
 * carries retries, dead-lettering and a `sync_notifications` row when a server refuses.
 * A second retry mechanism living inside the outbox processor would have to reimplement
 * all of it to be equally honest about failure.
 *
 * Also valid for `kind = 'send'`: composing from a draft and sending it should leave no
 * draft behind, and that is the same intent with a different final destination.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ON DELETE SET NULL rather than CASCADE: retention removing the superseded message
  // long afterwards must not remove the record of what replaced it.
  await sql`
    ALTER TABLE outbox ADD COLUMN replaces_message_id UUID
      REFERENCES messages(id) ON DELETE SET NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE outbox DROP COLUMN replaces_message_id`.execute(db);
}
