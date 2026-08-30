import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * `old_folder_id` on message update events whose `changed` includes `folder_id`.
 *
 * A move event reported only the destination, so a consumer could tell that a message
 * had arrived somewhere but not where it came from. Recovering that meant keeping a
 * shadow copy of every message's folder purely to diff against -- state the contract
 * exists to save a consumer from keeping, and state that goes stale across a missed
 * reconnect. `OLD` is available here, and the sync_queue move trigger already captures
 * the same pair, so the information was present at the moment the event fired.
 *
 * The key is added only when the folder actually changed. `jsonb_build_object` keeps a
 * key whose value is NULL, so the payload is built and then extended rather than
 * carrying `old_folder_id: null` on every unrelated flag change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION notify_message_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      backfill text := COALESCE(current_setting('postimap.backfill', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
      payload jsonb;
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

      payload := jsonb_build_object(
        'v', 1, 'type', 'message', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.account_id, 'folder_id', NEW.folder_id, 'origin', origin,
        'changed', to_jsonb(changed)
      );

      IF OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN
        payload := payload || jsonb_build_object('old_folder_id', OLD.folder_id);
      END IF;

      PERFORM pg_notify('postimap_events', payload::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION notify_message_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      backfill text := COALESCE(current_setting('postimap.backfill', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
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
}
