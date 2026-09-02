import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * CalDAV/CardDAV mirror tables, alongside the IMAP ones. CalDAV and CardDAV share every
 * table, distinguished by `kind`. Recurrence is not expanded here: one row per UID holds
 * the master plus its RECURRENCE-ID exceptions exactly as the server stores them --
 * expansion by date range is a read-time consumer concern, the same division as
 * threading-vs-subject-heuristics on the IMAP side.
 *
 * `dav_sync_queue` is internal, matching `sync_queue`. `dav_notifications` mirrors
 * `sync_notifications` as its own table rather than widened columns on that one -- see
 * docs/consumer-contract.md for why.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("dav_accounts")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("username", "text", (col) => col.notNull())
    .addColumn("password", sql`bytea`, (col) => col.notNull())
    .addColumn("is_active", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("state", "text", (col) =>
      col
        .notNull()
        .defaultTo("created")
        .check(sql`state IN ('created','syncing','active','error','disabled')`),
    )
    .addColumn("state_error", "text")
    .addColumn("principal_url", "text")
    .addColumn("calendar_home_url", "text")
    .addColumn("addressbook_home_url", "text")
    .addColumn("last_polled_at", "timestamptz")
    .addColumn("error_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("dav_collections")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("account_id", "uuid", (col) =>
      col.notNull().references("dav_accounts.id").onDelete("cascade"),
    )
    .addColumn("kind", "text", (col) =>
      col.notNull().check(sql`kind IN ('calendar','addressbook')`),
    )
    .addColumn("href", "text")
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("display_name", "text")
    .addColumn("color", "text")
    .addColumn("description", "text")
    .addColumn("supported_components", sql`text[]`)
    .addColumn("read_only", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("sync_tier", "text", (col) => col.check(sql`sync_tier IN ('sync','ctag','full')`))
    .addColumn("sync_token", "text")
    .addColumn("ctag", "text")
    .addColumn("initial_sync_done", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("backfill_total", "integer")
    .addColumn("total_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_synced_at", "timestamptz")
    .addColumn("last_full_reconcile_at", "timestamptz")
    .addColumn("sync_error", "text")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    CREATE UNIQUE INDEX dav_collections_account_id_href_unique
      ON dav_collections (account_id, href) WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex("idx_dav_collections_account")
    .on("dav_collections")
    .column("account_id")
    .execute();

  await db.schema
    .createTable("dav_objects")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("account_id", "uuid", (col) =>
      col.notNull().references("dav_accounts.id").onDelete("cascade"),
    )
    .addColumn("collection_id", "uuid", (col) =>
      col.notNull().references("dav_collections.id").onDelete("cascade"),
    )
    .addColumn("href", "text")
    .addColumn("etag", "text")
    .addColumn("kind", "text", (col) =>
      col.notNull().check(sql`kind IN ('calendar','addressbook')`),
    )
    .addColumn("data", "text", (col) => col.notNull())
    .addColumn("uid", "text")
    .addColumn("component", "text", (col) =>
      col.check(sql`component IN ('VEVENT','VTODO','VJOURNAL','VCARD')`),
    )
    .addColumn("summary", "text")
    .addColumn("dtstart", "timestamptz")
    .addColumn("dtend", "timestamptz")
    .addColumn("dtstart_tz", "text")
    .addColumn("all_day", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("is_recurring", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("has_exceptions", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("status", "text")
    .addColumn("sequence", "integer")
    .addColumn("organizer", "text")
    .addColumn("attendees", "jsonb")
    .addColumn("emails", sql`text[]`)
    .addColumn("last_modified", "timestamptz")
    .addColumn("size_bytes", "integer")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    CREATE UNIQUE INDEX dav_objects_collection_id_href_unique
      ON dav_objects (collection_id, href) WHERE href IS NOT NULL
  `.execute(db);

  // Servers enforce one resource per UID per collection too; this is what lets an
  // in-place update find the row an incoming REQUEST/CANCEL/REPLY refers to.
  await sql`
    CREATE UNIQUE INDEX dav_objects_collection_id_uid_unique
      ON dav_objects (collection_id, uid) WHERE deleted_at IS NULL AND uid IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX idx_dav_objects_account_uid
      ON dav_objects (account_id, uid) WHERE deleted_at IS NULL AND uid IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX idx_dav_objects_collection_dtstart
      ON dav_objects (collection_id, dtstart)
      WHERE deleted_at IS NULL AND kind = 'calendar'
  `.execute(db);

  await sql`CREATE INDEX idx_dav_objects_emails ON dav_objects USING gin(emails)`.execute(db);

  await sql`
    CREATE TABLE dav_sync_queue (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id      UUID NOT NULL REFERENCES dav_accounts(id) ON DELETE CASCADE,
      collection_id   UUID REFERENCES dav_collections(id) ON DELETE SET NULL,
      object_id       UUID REFERENCES dav_objects(id) ON DELETE SET NULL,
      action          TEXT NOT NULL
                      CHECK (action IN ('put','move','delete','mkcol','proppatch','rmcol')),
      payload         JSONB NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','completed','failed','dead')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 5,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at    TIMESTAMPTZ,
      next_retry_at   TIMESTAMPTZ DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_dsq_pending ON dav_sync_queue(account_id, status, next_retry_at)
      WHERE status IN ('pending', 'failed')
  `.execute(db);

  await sql`CREATE INDEX idx_dsq_object_status ON dav_sync_queue(object_id, status)`.execute(db);

  await sql`
    CREATE TABLE dav_notifications (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id      UUID NOT NULL REFERENCES dav_accounts(id) ON DELETE CASCADE,
      action          TEXT NOT NULL,
      collection_id   UUID REFERENCES dav_collections(id) ON DELETE SET NULL,
      object_id       UUID REFERENCES dav_objects(id) ON DELETE SET NULL,
      error           TEXT,
      detail          JSONB,
      acknowledged_at TIMESTAMPTZ,
      reverted_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_dav_notifications_unacknowledged
      ON dav_notifications(account_id, created_at DESC)
      WHERE acknowledged_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("dav_notifications").ifExists().execute();
  await db.schema.dropTable("dav_sync_queue").ifExists().execute();
  await db.schema.dropTable("dav_objects").ifExists().execute();
  await db.schema.dropTable("dav_collections").ifExists().execute();
  await db.schema.dropTable("dav_accounts").ifExists().execute();
}
