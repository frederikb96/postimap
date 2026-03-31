import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { SyncTier } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("sync-state");

export interface SyncStateUpdate {
  syncTier?: SyncTier;
  foldersSynced?: number;
  foldersTotal?: number;
  messagesSynced?: bigint;
  errorCount?: number;
  lastError?: string | null;
  isIncremental?: boolean;
}

/** UPSERT sync_state for an account after a sync cycle */
export async function updateSyncState(
  db: Kysely<Database>,
  accountId: string,
  update: SyncStateUpdate,
): Promise<void> {
  try {
    const now = new Date();
    const values: Record<string, unknown> = {
      account_id: accountId,
      updated_at: now,
    };

    if (update.syncTier !== undefined) values.sync_tier = update.syncTier;
    if (update.foldersSynced !== undefined) values.folders_synced = update.foldersSynced;
    if (update.foldersTotal !== undefined) values.folders_total = update.foldersTotal;
    if (update.messagesSynced !== undefined) values.messages_synced = String(update.messagesSynced);
    if (update.errorCount !== undefined) values.error_count = update.errorCount;
    if (update.lastError !== undefined) values.last_error = update.lastError;

    if (update.isIncremental === true) {
      values.last_incr_sync = now;
    } else if (update.isIncremental === false) {
      values.last_full_sync = now;
    }

    // Build the ON CONFLICT update set dynamically
    const updateSet: Record<string, unknown> = { updated_at: now };

    if (update.syncTier !== undefined) updateSet.sync_tier = update.syncTier;
    if (update.foldersSynced !== undefined) updateSet.folders_synced = update.foldersSynced;
    if (update.foldersTotal !== undefined) updateSet.folders_total = update.foldersTotal;
    if (update.messagesSynced !== undefined) {
      updateSet.messages_synced = String(update.messagesSynced);
    }
    if (update.errorCount !== undefined) updateSet.error_count = update.errorCount;
    if (update.lastError !== undefined) updateSet.last_error = update.lastError;
    if (update.isIncremental === true) updateSet.last_incr_sync = now;
    if (update.isIncremental === false) updateSet.last_full_sync = now;

    await db
      .insertInto("sync_state")
      .values(values as never)
      .onConflict((oc) => oc.column("account_id").doUpdateSet(updateSet as never))
      .execute();
  } catch (err) {
    log.error({ err, accountId }, "Failed to update sync_state");
  }
}
