import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // accounts
  await db.schema
    .createTable("accounts")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("imap_host", "text", (col) => col.notNull())
    .addColumn("imap_port", "integer", (col) => col.notNull().defaultTo(993))
    .addColumn("imap_user", "text", (col) => col.notNull())
    .addColumn("imap_password", sql`bytea`, (col) => col.notNull())
    .addColumn("smtp_host", "text")
    .addColumn("smtp_port", "integer")
    .addColumn("smtp_user", "text")
    .addColumn("smtp_password", sql`bytea`)
    .addColumn("is_active", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("state", "text", (col) =>
      col
        .notNull()
        .defaultTo("created")
        .check(sql`state IN ('created','syncing','active','error','disabled')`),
    )
    .addColumn("state_error", "text")
    .addColumn("capabilities", "jsonb")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // folders
  await db.schema
    .createTable("folders")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("account_id", "uuid", (col) =>
      col.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("imap_name", "text", (col) => col.notNull())
    .addColumn("display_name", "text")
    .addColumn("separator", sql`char(1)`)
    .addColumn("mailbox_id", "text")
    .addColumn("special_use", "text", (col) =>
      col.check(
        sql`special_use IN ('inbox','sent','drafts','trash','junk','archive','all','flagged')`,
      ),
    )
    .addColumn("uidvalidity", "bigint")
    .addColumn("uidnext", "bigint")
    .addColumn("highestmodseq", "bigint")
    .addColumn("exists_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("total_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("unread_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_synced_at", "timestamptz")
    .addColumn("sync_error", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("folders_account_id_imap_name_unique", ["account_id", "imap_name"])
    .execute();

  await db.schema.createIndex("idx_folders_account").on("folders").column("account_id").execute();

  await db.schema
    .createIndex("idx_folders_mailbox_id")
    .on("folders")
    .columns(["account_id", "mailbox_id"])
    .where(sql.ref("mailbox_id"), "is not", null)
    .execute();

  // messages
  await db.schema
    .createTable("messages")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("account_id", "uuid", (col) =>
      col.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("folder_id", "uuid", (col) =>
      col.notNull().references("folders.id").onDelete("cascade"),
    )
    .addColumn("imap_uid", "bigint", (col) => col.notNull())
    .addColumn("message_id", "text")
    .addColumn("subject", "text")
    .addColumn("from_addr", "text")
    .addColumn("to_addrs", "jsonb")
    .addColumn("cc_addrs", "jsonb")
    .addColumn("bcc_addrs", "jsonb")
    .addColumn("reply_to", "text")
    .addColumn("in_reply_to", "text")
    .addColumn("references", sql`text[]`)
    .addColumn("body_text", "text")
    .addColumn("body_html", "text")
    .addColumn("raw_headers", "jsonb")
    .addColumn("raw_source", sql`bytea`)
    .addColumn("received_at", "timestamptz")
    .addColumn("size_bytes", "integer")
    .addColumn("modseq", "bigint")
    .addColumn("is_seen", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("is_flagged", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("is_answered", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("is_draft", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("is_deleted", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("keywords", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("sync_version", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("deleted_at", "timestamptz")
    .addColumn("search_vector", sql`tsvector`)
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("messages_folder_id_imap_uid_unique", ["folder_id", "imap_uid"])
    .execute();

  await db.schema
    .createIndex("idx_msg_folder_uid")
    .on("messages")
    .columns(["folder_id", "imap_uid"])
    .execute();

  await db.schema.createIndex("idx_msg_message_id").on("messages").column("message_id").execute();

  await sql`CREATE INDEX idx_msg_received ON messages(folder_id, received_at DESC)`.execute(db);

  await db.schema.createIndex("idx_msg_account").on("messages").column("account_id").execute();

  await sql`CREATE INDEX idx_msg_search ON messages USING gin(search_vector)`.execute(db);

  await db.schema
    .createIndex("idx_msg_sync_version")
    .on("messages")
    .column("sync_version")
    .execute();

  // attachments
  await db.schema
    .createTable("attachments")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("message_id", "uuid", (col) =>
      col.notNull().references("messages.id").onDelete("cascade"),
    )
    .addColumn("filename", "text")
    .addColumn("content_type", "text")
    .addColumn("content_id", "text")
    .addColumn("size_bytes", "integer")
    .addColumn("data", sql`bytea`)
    .execute();

  await db.schema.createIndex("idx_att_message").on("attachments").column("message_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("attachments").ifExists().execute();
  await db.schema.dropTable("messages").ifExists().execute();
  await db.schema.dropTable("folders").ifExists().execute();
  await db.schema.dropTable("accounts").ifExists().execute();
}
