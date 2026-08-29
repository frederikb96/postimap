import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * postimap_events: the single versioned NOTIFY channel consumers listen to for row
 * changes on messages, folders, accounts and outbox. Every payload is valid JSON
 * (pg-listen silently drops anything that isn't) and carries `origin`, sourced from the
 * same `postimap.writer` GUC the loop guard uses: 'sync' when PostIMAP made the write,
 * 'app' otherwise.
 *
 * Backfill suppression: while a sync-engine transaction has `postimap.backfill = 'on'`
 * set (the initial full sync of a folder), per-row message events are suppressed. A
 * single `{"type":"folder","op":"sync_complete","backfill":true}` event fires instead
 * once that folder's `initial_sync_done` flips to true.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION notify_message_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      backfill text := COALESCE(current_setting('postimap.backfill', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      op text;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'message', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.account_id, 'folder_id', OLD.folder_id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF backfill <> 'on' THEN
          PERFORM pg_notify('postimap_events', jsonb_build_object(
            'v', 1, 'type', 'message', 'op', 'insert', 'id', NEW.id,
            'account_id', NEW.account_id, 'folder_id', NEW.folder_id, 'origin', origin
          )::text);
        END IF;
        RETURN NEW;
      END IF;

      -- UPDATE
      IF backfill = 'on' THEN
        RETURN NEW;
      END IF;

      IF OLD.is_seen IS DISTINCT FROM NEW.is_seen THEN changed := array_append(changed, 'is_seen'); END IF;
      IF OLD.is_flagged IS DISTINCT FROM NEW.is_flagged THEN changed := array_append(changed, 'is_flagged'); END IF;
      IF OLD.is_answered IS DISTINCT FROM NEW.is_answered THEN changed := array_append(changed, 'is_answered'); END IF;
      IF OLD.is_draft IS DISTINCT FROM NEW.is_draft THEN changed := array_append(changed, 'is_draft'); END IF;
      IF OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN changed := array_append(changed, 'is_deleted'); END IF;
      IF OLD.keywords IS DISTINCT FROM NEW.keywords THEN changed := array_append(changed, 'keywords'); END IF;
      IF OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN changed := array_append(changed, 'folder_id'); END IF;
      IF OLD.imap_uid IS DISTINCT FROM NEW.imap_uid THEN changed := array_append(changed, 'imap_uid'); END IF;
      IF OLD.expunged_at IS DISTINCT FROM NEW.expunged_at THEN changed := array_append(changed, 'expunged_at'); END IF;
      IF OLD.subject IS DISTINCT FROM NEW.subject THEN changed := array_append(changed, 'subject'); END IF;
      IF OLD.received_at IS DISTINCT FROM NEW.received_at THEN changed := array_append(changed, 'received_at'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'message', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.account_id, 'folder_id', NEW.folder_id, 'origin', origin,
        'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER messages_events
      AFTER INSERT OR DELETE OR UPDATE OF
        is_seen, is_flagged, is_answered, is_draft, is_deleted,
        keywords, folder_id, imap_uid, expunged_at, subject, received_at
      ON messages
      FOR EACH ROW
      EXECUTE FUNCTION notify_message_event()
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

  await sql`
    CREATE OR REPLACE FUNCTION notify_account_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'account', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'account', 'op', 'insert', 'id', NEW.id,
          'account_id', NEW.id, 'origin', origin
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN changed := array_append(changed, 'is_active'); END IF;
      IF OLD.state IS DISTINCT FROM NEW.state THEN changed := array_append(changed, 'state'); END IF;
      IF OLD.name IS DISTINCT FROM NEW.name THEN changed := array_append(changed, 'name'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'account', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.id, 'origin', origin, 'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER accounts_events
      AFTER INSERT OR DELETE OR UPDATE OF is_active, state, name
      ON accounts
      FOR EACH ROW
      EXECUTE FUNCTION notify_account_event()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION notify_outbox_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'outbox', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.account_id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'outbox',
        'op', CASE WHEN TG_OP = 'INSERT' THEN 'insert' ELSE 'update' END,
        'id', NEW.id, 'account_id', NEW.account_id, 'origin', origin,
        'changed', CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_array('status') ELSE NULL END
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER outbox_events
      AFTER INSERT OR DELETE OR UPDATE OF status
      ON outbox
      FOR EACH ROW
      EXECUTE FUNCTION notify_outbox_event()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS outbox_events ON outbox`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_outbox_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS accounts_events ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_account_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS folders_events ON folders`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_folder_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS messages_events ON messages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_message_event()`.execute(db);
}
