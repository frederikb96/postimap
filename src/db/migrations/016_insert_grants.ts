import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Column-level INSERT grants on the three consumer-insertable tables.
 *
 * A table-level INSERT grant lets a consumer write the columns the contract calls
 * read-only, and the failure is silent: an `outbox` row inserted with `status = 'sent'`
 * is never claimed by the processor, so the mail simply never leaves and nothing reports
 * an error. An ORM sending model defaults on every INSERT does exactly this without the
 * calling code mentioning the column.
 *
 * The documented contract is unchanged -- this is the database enforcing what
 * docs/consumer-contract.md already said.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE INSERT ON accounts, outbox, outbox_attachments FROM postimap_app`.execute(db);

  // id is insertable throughout: a consumer choosing its own primary key can reference a
  // row before reading it back, which is how an attachment is attached to an outbox entry
  // before the entry is picked up.
  await sql`
    GRANT INSERT (
      id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active
    ) ON accounts TO postimap_app
  `.execute(db);

  await sql`
    GRANT INSERT (
      id, account_id, kind, from_addr, to_addrs, cc_addrs, bcc_addrs,
      subject, body_text, body_html, in_reply_to, "references",
      max_attempts, replaces_message_id
    ) ON outbox TO postimap_app
  `.execute(db);

  await sql`
    GRANT INSERT (id, outbox_id, filename, content_type, data)
    ON outbox_attachments TO postimap_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE INSERT ON accounts, outbox, outbox_attachments FROM postimap_app`.execute(db);
  await sql`GRANT INSERT ON accounts, outbox, outbox_attachments TO postimap_app`.execute(db);
}
