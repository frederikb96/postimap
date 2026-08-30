import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * folders.backfill_total -- how many messages the server reported for this folder at the
 * moment its initial full sync started.
 *
 * It is the denominator `total_count` never had. Written before the first message is
 * fetched, so the pair also identifies which folder is being worked on right now:
 * NULL means not started, set with `initial_sync_done = false` means in flight, and
 * `initial_sync_done = true` means finished. Per-message events are suppressed during a
 * backfill, so without this a consumer watching a large first sync sees nothing move
 * between the folder starting and the `sync_complete` event hours later.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE folders ADD COLUMN backfill_total INTEGER`.execute(db);

  // Two halves, both required: the trigger's UPDATE OF list decides whether the function
  // runs at all, and the function's own comparison chain decides whether it notifies.
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

      -- UPDATE: initial_sync_done flipping true is reported as its own event type,
      -- not folded into the generic 'update' op.
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
      IF OLD.backfill_total IS DISTINCT FROM NEW.backfill_total THEN changed := array_append(changed, 'backfill_total'); END IF;

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
        imap_name, display_name, special_use, deleted_at, initial_sync_done, backfill_total
      ON folders
      FOR EACH ROW
      EXECUTE FUNCTION notify_folder_event()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS folders_events ON folders`.execute(db);

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

  await sql`
    CREATE TRIGGER folders_events
      AFTER INSERT OR DELETE OR UPDATE OF
        imap_name, display_name, special_use, deleted_at, initial_sync_done
      ON folders
      FOR EACH ROW
      EXECUTE FUNCTION notify_folder_event()
  `.execute(db);

  await sql`ALTER TABLE folders DROP COLUMN IF EXISTS backfill_total`.execute(db);
}
