import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Column-level grants for the DAV tables, additive to the existing contract --
 * `postimap_info.contract_version` stays at 1. `postimap_app` already has schema USAGE
 * from 005_contract.ts; nothing to add there.
 *
 * The parsed columns on `dav_objects` (`uid`, `summary`, `dtstart`, ...) carry no grant at
 * all: they are PostIMAP's reading of `data`, written back once the outbound processor
 * claims a `put` and again from the server's copy after it lands. `id` is insertable on
 * every table the same way `accounts`/`outbox` already allow it, so a consumer can
 * reference a row before reading it back.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    GRANT SELECT ON dav_accounts, dav_collections, dav_objects, dav_notifications
    TO postimap_app
  `.execute(db);

  await sql`
    GRANT INSERT (id, name, url, username, password, is_active)
    ON dav_accounts TO postimap_app
  `.execute(db);
  await sql`GRANT UPDATE (name, password, is_active) ON dav_accounts TO postimap_app`.execute(db);
  // Every child cascades from dav_accounts via ON DELETE CASCADE -- the same shape as
  // 007_account_delete.ts, no delete grant needed anywhere else.
  await sql`GRANT DELETE ON dav_accounts TO postimap_app`.execute(db);

  await sql`
    GRANT INSERT (id, account_id, kind, slug, display_name, color, description)
    ON dav_collections TO postimap_app
  `.execute(db);
  await sql`
    GRANT UPDATE (display_name, color, description, deleted_at)
    ON dav_collections TO postimap_app
  `.execute(db);

  await sql`
    GRANT INSERT (id, account_id, collection_id, data)
    ON dav_objects TO postimap_app
  `.execute(db);
  await sql`
    GRANT UPDATE (data, collection_id, deleted_at)
    ON dav_objects TO postimap_app
  `.execute(db);

  // Acknowledging is the only thing a consumer does to this table, same as sync_notifications.
  await sql`GRANT UPDATE (acknowledged_at) ON dav_notifications TO postimap_app`.execute(db);

  // dav_sync_queue is intentionally never granted -- it is PostIMAP-internal.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    REVOKE ALL ON dav_accounts, dav_collections, dav_objects, dav_notifications
    FROM postimap_app
  `.execute(db);
}
