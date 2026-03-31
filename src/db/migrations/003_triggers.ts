import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Flag change trigger (outbound detection + loop prevention)
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_flag_change() RETURNS trigger AS $$
    BEGIN
      -- Loop prevention: skip if sync engine made this change
      IF NEW.sync_version > OLD.sync_version THEN
        RETURN NEW;
      END IF;

      -- Detect each flag change and enqueue
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
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'flag_add',
          jsonb_build_object('keywords_old', OLD.keywords, 'keywords_new', NEW.keywords));
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER message_flag_change
      AFTER UPDATE OF is_seen, is_flagged, is_answered, is_draft, is_deleted, keywords
      ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_flag_change()
  `.execute(db);

  // Move trigger
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_move() RETURNS trigger AS $$
    BEGIN
      IF NEW.sync_version > OLD.sync_version THEN
        RETURN NEW;
      END IF;
      IF OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'move',
          jsonb_build_object(
            'from_folder_id', OLD.folder_id,
            'to_folder_id', NEW.folder_id));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER message_move
      AFTER UPDATE OF folder_id ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_move()
  `.execute(db);

  // Soft delete trigger
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_soft_delete() RETURNS trigger AS $$
    BEGIN
      IF NEW.sync_version > OLD.sync_version THEN
        RETURN NEW;
      END IF;
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        INSERT INTO sync_queue (account_id, message_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'delete',
          jsonb_build_object('imap_uid', NEW.imap_uid::text, 'folder_id', NEW.folder_id));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER message_soft_delete
      AFTER UPDATE OF deleted_at ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_soft_delete()
  `.execute(db);

  // sync_queue NOTIFY trigger
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

  // search_vector auto-update trigger
  await sql`
    CREATE OR REPLACE FUNCTION trg_message_search_vector() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english',
        coalesce(NEW.subject, '') || ' ' ||
        coalesce(NEW.from_addr, '') || ' ' ||
        coalesce(NEW.body_text, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER message_search_vector
      BEFORE INSERT OR UPDATE OF subject, from_addr, body_text
      ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_message_search_vector()
  `.execute(db);

  // Folder count maintenance trigger
  await sql`
    CREATE OR REPLACE FUNCTION trg_folder_counts() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE folders SET
          total_count = total_count + 1,
          unread_count = unread_count + CASE WHEN NOT NEW.is_seen THEN 1 ELSE 0 END
        WHERE id = NEW.folder_id;
        RETURN NEW;

      ELSIF TG_OP = 'DELETE' THEN
        UPDATE folders SET
          total_count = total_count - 1,
          unread_count = unread_count - CASE WHEN NOT OLD.is_seen THEN 1 ELSE 0 END
        WHERE id = OLD.folder_id;
        RETURN OLD;

      ELSIF TG_OP = 'UPDATE' THEN
        -- folder_id changed: adjust counts on both folders
        IF OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN
          UPDATE folders SET
            total_count = total_count - 1,
            unread_count = unread_count - CASE WHEN NOT OLD.is_seen THEN 1 ELSE 0 END
          WHERE id = OLD.folder_id;
          UPDATE folders SET
            total_count = total_count + 1,
            unread_count = unread_count + CASE WHEN NOT NEW.is_seen THEN 1 ELSE 0 END
          WHERE id = NEW.folder_id;

        -- is_seen changed: adjust unread_count on current folder
        ELSIF OLD.is_seen IS DISTINCT FROM NEW.is_seen THEN
          UPDATE folders SET
            unread_count = unread_count + CASE WHEN NEW.is_seen THEN -1 ELSE 1 END
          WHERE id = NEW.folder_id;

        -- soft delete: decrement counts
        ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
          UPDATE folders SET
            total_count = total_count - 1,
            unread_count = unread_count - CASE WHEN NOT NEW.is_seen THEN 1 ELSE 0 END
          WHERE id = NEW.folder_id;

        END IF;
        RETURN NEW;
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER message_folder_counts
      AFTER INSERT OR UPDATE OF folder_id, is_seen, deleted_at OR DELETE
      ON messages
      FOR EACH ROW
      EXECUTE FUNCTION trg_folder_counts()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop triggers first, then functions
  await sql`DROP TRIGGER IF EXISTS message_folder_counts ON messages`.execute(db);
  await sql`DROP TRIGGER IF EXISTS message_search_vector ON messages`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_sync_queue_notify ON sync_queue`.execute(db);
  await sql`DROP TRIGGER IF EXISTS message_soft_delete ON messages`.execute(db);
  await sql`DROP TRIGGER IF EXISTS message_move ON messages`.execute(db);
  await sql`DROP TRIGGER IF EXISTS message_flag_change ON messages`.execute(db);

  await sql`DROP FUNCTION IF EXISTS trg_folder_counts()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_search_vector()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_sync_queue_insert()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_soft_delete()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_move()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_message_flag_change()`.execute(db);
}
