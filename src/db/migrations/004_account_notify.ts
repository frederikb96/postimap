import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION trg_account_changes() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('account_changes', json_build_object('id', OLD.id, 'op', TG_OP)::text);
        RETURN OLD;
      ELSE
        PERFORM pg_notify('account_changes', json_build_object('id', NEW.id, 'op', TG_OP)::text);
        RETURN NEW;
      END IF;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER account_changes
      AFTER INSERT OR UPDATE OR DELETE
      ON accounts
      FOR EACH ROW
      EXECUTE FUNCTION trg_account_changes()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS account_changes ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_account_changes()`.execute(db);
}
