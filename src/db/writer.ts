import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "./schema.js";

export interface SyncWriterOptions {
  /**
   * Marks the transaction as the initial full sync of a folder. The events trigger
   * suppresses per-row message notifications while this is set; the caller is
   * responsible for flipping `folders.initial_sync_done` (also via this helper) once the
   * folder's backfill completes, which fires the single sync_complete event instead.
   */
  backfill?: boolean;
}

/**
 * Runs `fn` inside a transaction with `postimap.writer = 'sync'` set for its duration.
 * This is how every sync-engine write identifies itself to the database: outbound
 * enqueue triggers skip writes made this way, and the postimap_events NOTIFY payloads
 * report them with origin "sync" instead of "app".
 *
 * `SET LOCAL` resets at COMMIT/ROLLBACK, so it never leaks onto the next query on a
 * pooled connection.
 */
export async function withSyncWriter<T>(
  db: Kysely<Database>,
  fn: (trx: Kysely<Database>) => Promise<T>,
  options: SyncWriterOptions = {},
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL postimap.writer = 'sync'`.execute(trx);
    if (options.backfill) {
      await sql`SET LOCAL postimap.backfill = 'on'`.execute(trx);
    }
    return fn(trx);
  });
}
