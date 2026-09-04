import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Content ID for an outbox attachment, so composition can embed it inline instead of only
 * ever attaching it.
 *
 * Nothing about `data`/`filename`/`content_type` says whether an attachment is meant to be
 * shown inline or offered as a download -- that's exactly what a `Content-ID` and an
 * `<img src="cid:...">` reference in `body_html` do. A row with no content_id composes
 * exactly as before, as a plain attachment.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE outbox_attachments ADD COLUMN content_id TEXT`.execute(db);

  await sql`
    GRANT INSERT (content_id) ON outbox_attachments TO postimap_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE INSERT (content_id) ON outbox_attachments FROM postimap_app`.execute(db);
  await sql`ALTER TABLE outbox_attachments DROP COLUMN content_id`.execute(db);
}
