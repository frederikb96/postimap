import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * A third outbox kind: append stored message bytes straight onto the server, with a
 * chosen folder, flags and internal date, and no composition step at all.
 *
 * `send` and `draft` both go through nodemailer's MailComposer, which is right for mail
 * this application is authoring -- it never had a Message-ID, a DKIM signature or an
 * internal date of its own to preserve. `append` is for the opposite case: bytes that
 * already existed as a real message somewhere, kept only in a consumer's own storage, and
 * now going back onto the server exactly as they were. Composing them again would forge a
 * new Message-ID and lose everything about the original.
 *
 * `raw_source` and `target_folder_id` are the two columns this kind cannot run without;
 * `flags` and `internal_date` are optional the same way an ordinary APPEND's arguments
 * are -- omitted, the server picks no flags and the current time, same as `send`/`draft`
 * already accept today.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check
  `.execute(db);
  await sql`
    ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check
      CHECK (kind IN ('send','draft','append'))
  `.execute(db);

  await sql`
    ALTER TABLE outbox
      ADD COLUMN raw_source       BYTEA,
      ADD COLUMN target_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
      ADD COLUMN flags            TEXT[],
      ADD COLUMN internal_date    TIMESTAMPTZ
  `.execute(db);

  await sql`
    GRANT INSERT (raw_source, target_folder_id, flags, internal_date)
    ON outbox TO postimap_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    REVOKE INSERT (raw_source, target_folder_id, flags, internal_date)
    ON outbox FROM postimap_app
  `.execute(db);

  await sql`
    ALTER TABLE outbox
      DROP COLUMN raw_source,
      DROP COLUMN target_folder_id,
      DROP COLUMN flags,
      DROP COLUMN internal_date
  `.execute(db);

  // Rows naming a kind the restored constraint does not allow have to go first --
  // PostgreSQL refuses to add a CHECK the existing data violates.
  await sql`DELETE FROM outbox WHERE kind = 'append'`.execute(db);
  await sql`ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check`.execute(db);
  await sql`
    ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check
      CHECK (kind IN ('send','draft'))
  `.execute(db);
}
