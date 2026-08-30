import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Mirror the IMAP subscription state of each folder.
 *
 * IMAP separates folders that exist (LIST) from folders the user has chosen to see
 * (LSUB / LIST-EXTENDED). Mail clients show the subscribed ones, which is how an account
 * with forty labels does not drown a sidebar. PostIMAP already reads that field off every
 * LIST response and threw it away.
 *
 * The default is true, matching what a server that tracks no subscription state means:
 * everything is visible. Read-only for a consumer -- a `subscribed` column it could write
 * would be a grant with no caller until a UI has a "hide this folder" control.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE folders ADD COLUMN subscribed BOOLEAN NOT NULL DEFAULT true`.execute(db);

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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The function body names NEW.subscribed, so it has to stop doing that before the
  // column goes -- otherwise every later folder update raises.
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

  await sql`DROP TRIGGER IF EXISTS folders_events ON folders`.execute(db);
  await sql`
    CREATE TRIGGER folders_events
      AFTER INSERT OR DELETE OR UPDATE OF
        imap_name, display_name, special_use, deleted_at, initial_sync_done
      ON folders
      FOR EACH ROW
      EXECUTE FUNCTION notify_folder_event()
  `.execute(db);
  await sql`ALTER TABLE folders DROP COLUMN subscribed`.execute(db);
}
