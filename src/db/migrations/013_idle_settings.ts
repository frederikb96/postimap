import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Which folders get IMAP push, chosen per folder at runtime instead of per deployment.
 *
 * IDLE occupies a whole connection -- a connection parked in IDLE can do nothing else --
 * and every provider caps how many an account may hold, some counting per account and some
 * per user and source address. So the budget is small, belongs to the server, and cannot be
 * computed from here, which is why this is a deliberate per-folder choice rather than
 * watching everything.
 *
 * `idle_status` is PostIMAP's answer, and it is what makes a watch that has given up
 * visible: reconnection already backs off and retries, but when it finally stops, nothing
 * in the database changed and nothing fired -- the folder quietly stopped being real-time
 * while still syncing on the interval, so nothing looked broken and nobody was told.
 *
 * NULL means PostIMAP has not considered this folder yet, which is what lets `idle_folders`
 * seed a preference exactly once. After the first pass the column is never NULL again, so a
 * consumer switching every folder off is not mistaken for one that has expressed nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE folders ADD COLUMN idle_requested BOOLEAN NOT NULL DEFAULT false`.execute(
    db,
  );
  // 'connection_limit' is deliberately not a value here. Telling a provider's connection
  // cap apart from any other refused connection means matching on server error strings,
  // which differ per provider and change without notice -- a status that cannot be set
  // reliably is worse than one that does not exist, because a consumer builds a branch
  // nothing ever reaches. A refused connection reports 'failed' with the server's message.
  await sql`
    ALTER TABLE folders ADD COLUMN idle_status TEXT
      CHECK (idle_status IN ('off','watching','unsupported','failed'))
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION notify_folder_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'folder', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.account_id, 'folder_id', OLD.id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'folder', 'op', 'insert', 'id', NEW.id,
          'account_id', NEW.account_id, 'folder_id', NEW.id, 'origin', origin
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.initial_sync_done IS DISTINCT FROM NEW.initial_sync_done AND NEW.initial_sync_done THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'folder', 'op', 'sync_complete', 'id', NEW.id,
          'account_id', NEW.account_id, 'folder_id', NEW.id, 'origin', origin, 'backfill', true
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.imap_name IS DISTINCT FROM NEW.imap_name THEN changed := array_append(changed, 'imap_name'); END IF;
      IF OLD.display_name IS DISTINCT FROM NEW.display_name THEN changed := array_append(changed, 'display_name'); END IF;
      IF OLD.special_use IS DISTINCT FROM NEW.special_use THEN changed := array_append(changed, 'special_use'); END IF;
      IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN changed := array_append(changed, 'deleted_at'); END IF;
      IF OLD.subscribed IS DISTINCT FROM NEW.subscribed THEN changed := array_append(changed, 'subscribed'); END IF;
      IF OLD.idle_requested IS DISTINCT FROM NEW.idle_requested THEN changed := array_append(changed, 'idle_requested'); END IF;
      IF OLD.idle_status IS DISTINCT FROM NEW.idle_status THEN changed := array_append(changed, 'idle_status'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'folder', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.account_id, 'folder_id', NEW.id, 'origin', origin,
        'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS folders_events ON folders`.execute(db);
  await sql`
    CREATE TRIGGER folders_events
      AFTER INSERT OR DELETE OR UPDATE OF
        imap_name, display_name, special_use, deleted_at, initial_sync_done, subscribed,
        idle_requested, idle_status
      ON folders
      FOR EACH ROW
      EXECUTE FUNCTION notify_folder_event()
  `.execute(db);

  await sql`GRANT UPDATE (idle_requested) ON folders TO postimap_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE UPDATE (idle_requested) ON folders FROM postimap_app`.execute(db);

  // The function body names the columns, so it has to stop doing that before they go.
  await sql`
    CREATE OR REPLACE FUNCTION notify_folder_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'folder', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.account_id, 'folder_id', OLD.id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'folder', 'op', 'insert', 'id', NEW.id,
          'account_id', NEW.account_id, 'folder_id', NEW.id, 'origin', origin
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.initial_sync_done IS DISTINCT FROM NEW.initial_sync_done AND NEW.initial_sync_done THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'folder', 'op', 'sync_complete', 'id', NEW.id,
          'account_id', NEW.account_id, 'folder_id', NEW.id, 'origin', origin, 'backfill', true
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.imap_name IS DISTINCT FROM NEW.imap_name THEN changed := array_append(changed, 'imap_name'); END IF;
      IF OLD.display_name IS DISTINCT FROM NEW.display_name THEN changed := array_append(changed, 'display_name'); END IF;
      IF OLD.special_use IS DISTINCT FROM NEW.special_use THEN changed := array_append(changed, 'special_use'); END IF;
      IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN changed := array_append(changed, 'deleted_at'); END IF;
      IF OLD.subscribed IS DISTINCT FROM NEW.subscribed THEN changed := array_append(changed, 'subscribed'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'folder', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.account_id, 'folder_id', NEW.id, 'origin', origin,
        'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS folders_events ON folders`.execute(db);
  await sql`
    CREATE TRIGGER folders_events
      AFTER INSERT OR DELETE OR UPDATE OF
        imap_name, display_name, special_use, deleted_at, initial_sync_done, subscribed
      ON folders
      FOR EACH ROW
      EXECUTE FUNCTION notify_folder_event()
  `.execute(db);

  await sql`ALTER TABLE folders DROP COLUMN idle_status`.execute(db);
  await sql`ALTER TABLE folders DROP COLUMN idle_requested`.execute(db);
}
