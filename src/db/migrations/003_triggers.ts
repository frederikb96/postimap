import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Writer marker: sync-engine writes run inside a transaction that first does
  // SET LOCAL postimap.writer = 'sync'. SET LOCAL resets at COMMIT, so it cannot leak
  // across a pooled connection. Enqueue triggers skip when it is set; forgetting the
  // marker on a sync-engine write fails safe -- it just enqueues a harmless echo that
  // inbound reconciliation absorbs, never data loss.
  //
  // The trigger functions that write to sync_queue or folders run SECURITY DEFINER: a
  // consumer holding only the postimap_app grants (no access to sync_queue, no UPDATE on
  // folders) must still be able to flag/move/expunge a message and have the enqueue and
  // counter bookkeeping happen on its behalf. Ownership of these functions -- and
  // therefore whose privileges they run with -- follows whichever role runs the
  // migration, the same role that owns the tables.

  // Flag change trigger (outbound detection)
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_flag_change() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      kw text;
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;

      IF OLD.is_seen IS DISTINCT FROM NEW.is_seen THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id,
          CASE WHEN NEW.is_seen THEN 'flag_add' ELSE 'flag_remove' END,
          jsonb_build_object('flag', '\\Seen'));
      END IF;
      IF OLD.is_flagged IS DISTINCT FROM NEW.is_flagged THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id,
          CASE WHEN NEW.is_flagged THEN 'flag_add' ELSE 'flag_remove' END,
          jsonb_build_object('flag', '\\Flagged'));
      END IF;
      IF OLD.is_answered IS DISTINCT FROM NEW.is_answered THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id,
          CASE WHEN NEW.is_answered THEN 'flag_add' ELSE 'flag_remove' END,
          jsonb_build_object('flag', '\\Answered'));
      END IF;
      IF OLD.is_draft IS DISTINCT FROM NEW.is_draft THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id,
          CASE WHEN NEW.is_draft THEN 'flag_add' ELSE 'flag_remove' END,
          jsonb_build_object('flag', '\\Draft'));
      END IF;
      IF OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id,
          CASE WHEN NEW.is_deleted THEN 'flag_add' ELSE 'flag_remove' END,
          jsonb_build_object('flag', '\\Deleted'));
      END IF;
      IF OLD.keywords IS DISTINCT FROM NEW.keywords THEN
        -- Custom keywords/labels reuse the flag_add/flag_remove machinery: diff the two
        -- arrays and enqueue one entry per changed keyword, each carrying a {flag} payload
        -- the same shape the system-flag branches above already produce.
        FOREACH kw IN ARRAY COALESCE(NEW.keywords, '{}') LOOP
          IF kw <> ALL(COALESCE(OLD.keywords, '{}')) THEN
            INSERT INTO sync_queue (account_id, message_id, action, payload)
            VALUES (NEW.account_id, NEW.id, 'flag_add', jsonb_build_object('flag', kw));
          END IF;
        END LOOP;
        FOREACH kw IN ARRAY COALESCE(OLD.keywords, '{}') LOOP
          IF kw <> ALL(COALESCE(NEW.keywords, '{}')) THEN
            INSERT INTO sync_queue (account_id, message_id, action, payload)
            VALUES (NEW.account_id, NEW.id, 'flag_remove', jsonb_build_object('flag', kw));
          END IF;
        END LOOP;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER message_flag_change
      AFTER UPDATE OF is_seen, is_flagged, is_answered, is_draft, is_deleted, keywords
      ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_flag_change()
  `.execute(db);

  // Move trigger -- captures the OLD uid/folder so the outbound processor, which now
  // sees NULL for the current imap_uid on a pending optimistic move, still knows the
  // source location to operate on.
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_move() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      IF OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'move',
          jsonb_build_object(
            'from_folder_id', OLD.folder_id,
            'to_folder_id', NEW.folder_id,
            'old_imap_uid', OLD.imap_uid::text));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER message_move
      AFTER UPDATE OF folder_id ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_move()
  `.execute(db);

  // Expunge trigger (message gone from the IMAP server, distinct from the \Deleted flag)
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_expunge() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      IF OLD.expunged_at IS NULL AND NEW.expunged_at IS NOT NULL THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'delete',
          jsonb_build_object('imap_uid', NEW.imap_uid::text, 'folder_id', NEW.folder_id));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER message_expunge
      AFTER UPDATE OF expunged_at ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_expunge()
  `.execute(db);

  // sync_queue NOTIFY trigger (internal wakeup for the outbound processor)
  await sql`
    CREATE OR REPLACE FUNCTION notify_sync_queue_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify(
        'sync_queue_' || NEW.account_id::text,
        json_build_object('id', NEW.id, 'action', NEW.action)::text
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_sync_queue_notify
      AFTER INSERT ON sync_queue
      FOR EACH ROW
      EXECUTE FUNCTION notify_sync_queue_insert()
  `.execute(db);

  // outbox NOTIFY trigger -- internal wakeup for OutboxProcessor, separate from the
  // public postimap_events outbox notification (same split as sync_queue vs messages).
  await sql`
    CREATE OR REPLACE FUNCTION notify_outbox_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('outbox_' || NEW.account_id::text, json_build_object('id', NEW.id)::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_outbox_notify
      AFTER INSERT ON outbox
      FOR EACH ROW
      EXECUTE FUNCTION notify_outbox_insert()
  `.execute(db);

  // Folder count maintenance: delta formulation. Computes visibility/unread for OLD and
  // NEW independently, then applies the deltas -- one code path that gets every
  // combination right, including a folder move and a flag change in the same statement,
  // and un-expunging a message back to visible.
  await sql`
    CREATE OR REPLACE FUNCTION trg_folder_counts() RETURNS trigger AS $$
    DECLARE
      old_vis int := 0; old_unread int := 0;
      new_vis int := 0; new_unread int := 0;
    BEGIN
      IF TG_OP IN ('UPDATE','DELETE') AND OLD.expunged_at IS NULL THEN
        old_vis := 1; old_unread := CASE WHEN NOT OLD.is_seen THEN 1 ELSE 0 END;
      END IF;
      IF TG_OP IN ('UPDATE','INSERT') AND NEW.expunged_at IS NULL THEN
        new_vis := 1; new_unread := CASE WHEN NOT NEW.is_seen THEN 1 ELSE 0 END;
      END IF;

      IF TG_OP = 'UPDATE' AND OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN
        UPDATE folders SET total_count = total_count - old_vis, unread_count = unread_count - old_unread
          WHERE id = OLD.folder_id;
        UPDATE folders SET total_count = total_count + new_vis, unread_count = unread_count + new_unread
          WHERE id = NEW.folder_id;
      ELSE
        IF (new_vis - old_vis) <> 0 OR (new_unread - old_unread) <> 0 THEN
          UPDATE folders SET total_count = total_count + (new_vis - old_vis),
                              unread_count = unread_count + (new_unread - old_unread)
            WHERE id = COALESCE(NEW.folder_id, OLD.folder_id);
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER message_folder_counts
      AFTER INSERT OR DELETE OR UPDATE OF folder_id, is_seen, expunged_at
      ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_folder_counts()
  `.execute(db);

  // updated_at maintenance, shared across every table that carries the column
  await sql`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER accounts_set_updated_at
      BEFORE UPDATE ON accounts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);

  await sql`
    CREATE TRIGGER folders_set_updated_at
      BEFORE UPDATE ON folders
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);

  await sql`
    CREATE TRIGGER messages_set_updated_at
      BEFORE UPDATE ON messages
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);

  await sql`
    CREATE TRIGGER outbox_set_updated_at
      BEFORE UPDATE ON outbox
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_outbox_notify ON outbox`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_outbox_insert()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS outbox_set_updated_at ON outbox`.execute(db);
  await sql`DROP TRIGGER IF EXISTS messages_set_updated_at ON messages`.execute(db);
  await sql`DROP TRIGGER IF EXISTS folders_set_updated_at ON folders`.execute(db);
  await sql`DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS set_updated_at()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS message_folder_counts ON messages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_folder_counts()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS trg_sync_queue_notify ON sync_queue`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_sync_queue_insert()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS message_expunge ON messages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_expunge()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS message_move ON messages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_move()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS message_flag_change ON messages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_flag_change()`.execute(db);
}
