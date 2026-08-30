import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Consumer-driven folder creation and deletion.
 *
 * A consumer INSERTs a `folders` row to create a mailbox and sets `deleted_at` to remove
 * one -- the same idiom `messages` already uses for a move (`folder_id`) and a delete
 * (`expunged_at`), so there is no second mechanism to learn. Both enqueue to `sync_queue`
 * and skip when `postimap.writer = 'sync'`, which is what separates app intent from the
 * folder reconciliation writing the same columns on every cycle.
 *
 * Renaming stays out: IMAP `RENAME` also renames every child folder, so one command
 * invalidates the `imap_name` of an unbounded number of other rows. `imap_name` therefore
 * carries no UPDATE grant and a rename can only reach PG from the server.
 *
 * The name is captured into the payload at enqueue time. Retention hard-deletes a
 * long-tombstoned folder, and the outbound processor resolves the mailbox to delete by
 * joining the row -- a payload copy is what survives the row disappearing underneath it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sync_queue DROP CONSTRAINT sync_queue_action_check
  `.execute(db);

  await sql`
    ALTER TABLE sync_queue ADD CONSTRAINT sync_queue_action_check
      CHECK (action IN ('flag_add','flag_remove','move','delete','folder_create','folder_delete'))
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION trg_folder_create() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      INSERT INTO sync_queue (account_id, folder_id, action, payload)
      VALUES (NEW.account_id, NEW.id, 'folder_create',
        jsonb_build_object('imap_name', NEW.imap_name));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER folder_create_enqueue
      AFTER INSERT ON folders
      FOR EACH ROW
      EXECUTE FUNCTION trg_folder_create()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION trg_folder_delete() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        INSERT INTO sync_queue (account_id, folder_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'folder_delete',
          jsonb_build_object('imap_name', NEW.imap_name));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER folder_delete_enqueue
      AFTER UPDATE OF deleted_at ON folders
      FOR EACH ROW
      EXECUTE FUNCTION trg_folder_delete()
  `.execute(db);

  // account_id and imap_name are the whole insert surface: everything else on the row is
  // IMAP bookkeeping PostIMAP fills in once the mailbox exists and the first sync runs.
  await sql`GRANT INSERT (account_id, imap_name, display_name) ON folders TO postimap_app`.execute(
    db,
  );
  await sql`GRANT UPDATE (deleted_at, display_name) ON folders TO postimap_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE INSERT (account_id, imap_name, display_name) ON folders FROM postimap_app`.execute(
    db,
  );
  await sql`REVOKE UPDATE (deleted_at, display_name) ON folders FROM postimap_app`.execute(db);

  await sql`DROP TRIGGER IF EXISTS folder_delete_enqueue ON folders`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_folder_delete()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS folder_create_enqueue ON folders`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_folder_create()`.execute(db);

  // Rows naming an action the restored constraint does not allow have to go first --
  // PostgreSQL refuses to add a CHECK the existing data violates, so without this the whole
  // rollback fails on any database where a folder operation was ever queued.
  await sql`DELETE FROM sync_queue WHERE action IN ('folder_create','folder_delete')`.execute(db);
  await sql`ALTER TABLE sync_queue DROP CONSTRAINT sync_queue_action_check`.execute(db);
  await sql`
    ALTER TABLE sync_queue ADD CONSTRAINT sync_queue_action_check
      CHECK (action IN ('flag_add','flag_remove','move','delete'))
  `.execute(db);
}
