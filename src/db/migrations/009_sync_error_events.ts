import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * `sync_error` events on `postimap_events` when a `sync_queue` entry dead-letters.
 *
 * A consumer writes a flag or a move and the database accepts it; whether it ever
 * reached IMAP is decided later, out of band. When retries are exhausted the row is
 * marked `dead` -- inside `sync_queue`, which carries no consumer grant. The write is
 * then permanently diverged from the server with nothing saying so, until an inbound
 * sync silently reverts the column and the consumer reads it as someone else's change.
 *
 * The error text is truncated: a `pg_notify` payload over 8000 bytes raises, which
 * would abort the very UPDATE that records the dead-lettering.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION notify_sync_error_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
    BEGIN
      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'sync_error', 'op', 'dead', 'id', NEW.id::text,
        'account_id', NEW.account_id, 'message_id', NEW.message_id,
        'folder_id', NEW.folder_id, 'action', NEW.action,
        'error', left(COALESCE(NEW.error, ''), 500), 'origin', origin
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER sync_queue_dead_events
      AFTER UPDATE OF status ON sync_queue
      FOR EACH ROW
      WHEN (NEW.status = 'dead' AND OLD.status IS DISTINCT FROM 'dead')
      EXECUTE FUNCTION notify_sync_error_event()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_queue_dead_events ON sync_queue`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_sync_error_event()`.execute(db);
}
