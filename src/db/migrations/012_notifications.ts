import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * A durable record of a write that never reached the server.
 *
 * A consumer's write to a granted column is accepted by PostgreSQL immediately and reaches
 * IMAP afterwards. When that second half fails permanently the column still holds what the
 * consumer wrote, and stays that way until an inbound sync overwrites it -- arriving as an
 * ordinary `origin: "sync"` update, indistinguishable from someone editing the same message
 * in another mail client. `sync_error` on `postimap_events` announces the moment it happens
 * and nothing survives it, so a client that was not listening never learns.
 *
 * This is a separate table rather than columns on `sync_audit` because the two want
 * opposite retention rules. `sync_audit` is a debugging log purged on age; a notification
 * must not be destroyed while it is still unacknowledged, and one table cannot honour both
 * without a carve-out inside the purge. Keeping them apart also leaves `sync_audit`
 * genuinely append-only instead of append-only-except-one-column.
 *
 * One row per operation that reaches a terminal failure -- never one per retry.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE sync_notifications (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      action          TEXT NOT NULL,
      message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
      folder_id       UUID REFERENCES folders(id) ON DELETE SET NULL,
      outbox_id       UUID REFERENCES outbox(id) ON DELETE SET NULL,
      -- Not truncated. The 500-character cap on the sync_error NOTIFY exists only because
      -- pg_notify raises over 8000 bytes; a column has no such limit and the full server
      -- message is the useful half of a failure report.
      error           TEXT,
      -- What was attempted, plus enough of the object's identity to render the row after
      -- retention has removed the message it points at: the RFC 5322 Message-ID and the
      -- subject, captured here rather than joined live.
      detail          JSONB,
      acknowledged_at TIMESTAMPTZ,
      reverted_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  // The query a notification bell makes, both for the list and for its badge count.
  await sql`
    CREATE INDEX idx_notifications_unacknowledged
      ON sync_notifications(account_id, created_at DESC)
      WHERE acknowledged_at IS NULL
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION notify_notification_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
    BEGIN
      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'notification', 'op', 'insert', 'id', NEW.id,
        'account_id', NEW.account_id, 'message_id', NEW.message_id,
        'folder_id', NEW.folder_id, 'action', NEW.action, 'origin', origin
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER notifications_events
      AFTER INSERT ON sync_notifications
      FOR EACH ROW
      EXECUTE FUNCTION notify_notification_event()
  `.execute(db);

  await sql`GRANT SELECT ON sync_notifications TO postimap_app`.execute(db);
  // Acknowledging is the only thing a consumer does to this table. Everything else on the
  // row is PostIMAP's account of what happened.
  await sql`GRANT UPDATE (acknowledged_at) ON sync_notifications TO postimap_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE ALL ON sync_notifications FROM postimap_app`.execute(db);
  await sql`DROP TRIGGER IF EXISTS notifications_events ON sync_notifications`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_notification_event()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_notifications`.execute(db);
}
