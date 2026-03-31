import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import type { ImapClient } from "../imap/pool.js";
import { deleteMessage } from "../protocol/delete-handler.js";
import { syncFlagToImap } from "../protocol/flag-sync.js";
import { moveMessage } from "../protocol/move-handler.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";

const log = createLogger("outbound-sync");

/** Batch size for sync_queue processing */
const BATCH_SIZE = 10;

/** Represents a sync_queue row with joined message data */
interface QueueEntry {
  id: string;
  account_id: string;
  message_id: string | null;
  folder_id: string | null;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: Date;
  processed_at: Date | null;
  next_retry_at: Date;
  /** Joined from messages table */
  imap_uid: string | null;
  /** Joined from messages table */
  modseq: string | null;
}

export interface CoalesceResult {
  effective: QueueEntry[];
  superseded: QueueEntry[];
}

/**
 * Coalesce a batch of sync_queue entries to eliminate redundant IMAP operations.
 *
 * Groups by (message_id, action_type) and keeps only the last relevant entry:
 * - flag_add/flag_remove on same flag: only the LAST entry wins
 * - move: only the LAST move wins (intermediate destinations skipped)
 * - delete: supersedes all prior flag/move entries for that message
 */
export function coalesce(entries: QueueEntry[]): CoalesceResult {
  const effective: QueueEntry[] = [];
  const superseded: QueueEntry[] = [];

  // Group entries by message_id
  const byMessage = new Map<string, QueueEntry[]>();
  for (const entry of entries) {
    if (!entry.message_id) {
      // Entries without a message_id cannot be coalesced
      effective.push(entry);
      continue;
    }
    const group = byMessage.get(entry.message_id) ?? [];
    group.push(entry);
    byMessage.set(entry.message_id, group);
  }

  for (const [, group] of byMessage) {
    // Sort by created_at ascending so the last entry is the most recent
    group.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    // If any entry is a delete, it supersedes all others for this message
    const lastDelete = [...group].reverse().find((e) => e.action === "delete");
    if (lastDelete) {
      effective.push(lastDelete);
      for (const entry of group) {
        if (entry.id !== lastDelete.id) {
          superseded.push(entry);
        }
      }
      continue;
    }

    // Group flag entries by (action, flag) key; keep only the last per flag
    const flagEntries = group.filter((e) => e.action === "flag_add" || e.action === "flag_remove");
    const moveEntries = group.filter((e) => e.action === "move");

    // For flag changes: group by flag name, keep only the last action per flag
    const lastByFlag = new Map<string, QueueEntry>();
    for (const entry of flagEntries) {
      const flag = (entry.payload as { flag?: string }).flag ?? "";
      lastByFlag.set(flag, entry);
    }

    const effectiveFlags = new Set([...lastByFlag.values()].map((e) => e.id));
    for (const entry of flagEntries) {
      if (effectiveFlags.has(entry.id)) {
        effective.push(entry);
      } else {
        superseded.push(entry);
      }
    }

    // For moves: only the last move matters
    if (moveEntries.length > 0) {
      const lastMove = moveEntries[moveEntries.length - 1];
      effective.push(lastMove);
      for (const entry of moveEntries) {
        if (entry.id !== lastMove.id) {
          superseded.push(entry);
        }
      }
    }
  }

  return { effective, superseded };
}

/**
 * Outbound sync processor: consumes sync_queue entries and applies them to IMAP.
 *
 * Wakeup via PG LISTEN/NOTIFY per account, with polling fallback.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent processing.
 */
export class OutboundProcessor {
  private subscriber: Subscriber | null = null;
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private subscribedChannels = new Set<string>();
  /** Processing locks per account to prevent concurrent batch processing */
  private processing = new Set<string>();

  constructor(
    private db: Kysely<Database>,
    private databaseUrl: string,
    private getImapClient: (accountId: string) => ImapClient,
    private getCapabilities: (accountId: string) => Promise<ServerCapabilities | null>,
    private pollIntervalMs: number,
    private maxRetryAttempts: number,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Set up pg-listen subscriber
    this.subscriber = await createPgListener(this.databaseUrl);
    await this.subscriber.connect();

    // Subscribe to NOTIFY channels for all active accounts
    const accounts = await this.db
      .selectFrom("accounts")
      .select("id")
      .where("is_active", "=", true)
      .execute();

    for (const account of accounts) {
      await this.subscribeAccount(account.id);
    }

    log.info(
      { accountCount: accounts.length, pollIntervalMs: this.pollIntervalMs },
      "Outbound processor started",
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop all polling timers
    for (const [, timer] of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Close pg-listen subscriber (with timeout to avoid hanging)
    if (this.subscriber) {
      const sub = this.subscriber;
      this.subscriber = null;
      try {
        await Promise.race([
          (async () => {
            try {
              await sub.unlistenAll();
            } catch {}
            await sub.close();
          })(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      } catch {
        // Ignore errors during shutdown
      }
    }

    this.subscribedChannels.clear();
    this.processing.clear();
    log.info("Outbound processor stopped");
  }

  /** Subscribe to NOTIFY and start polling for a specific account */
  async subscribeAccount(accountId: string): Promise<void> {
    const channel = `sync_queue_${accountId}`;

    if (!this.subscribedChannels.has(channel) && this.subscriber) {
      this.subscriber.notifications.on(channel, () => {
        this.scheduleBatch(accountId);
      });
      await this.subscriber.listenTo(channel);
      this.subscribedChannels.add(channel);

      log.debug({ accountId, channel }, "Subscribed to NOTIFY channel");
    }

    // Start polling fallback
    if (!this.pollTimers.has(accountId)) {
      const timer = setInterval(() => {
        this.scheduleBatch(accountId);
      }, this.pollIntervalMs);
      this.pollTimers.set(accountId, timer);
    }

    // Process any existing pending entries immediately
    this.scheduleBatch(accountId);
  }

  /** Unsubscribe from NOTIFY and stop polling for a specific account */
  async unsubscribeAccount(accountId: string): Promise<void> {
    const channel = `sync_queue_${accountId}`;

    if (this.subscribedChannels.has(channel) && this.subscriber) {
      await this.subscriber.unlisten(channel);
      this.subscribedChannels.delete(channel);
    }

    const timer = this.pollTimers.get(accountId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(accountId);
    }
  }

  /** Schedule a batch processing run (debounced per account) */
  private scheduleBatch(accountId: string): void {
    if (!this.running) return;
    // Prevent concurrent processing for the same account
    if (this.processing.has(accountId)) return;

    this.processing.add(accountId);
    this.processBatch(accountId)
      .catch((err) => {
        log.error({ err, accountId }, "Batch processing failed");
      })
      .finally(() => {
        this.processing.delete(accountId);
      });
  }

  /**
   * Synchronously process ALL pending queue entries for an account until the queue is empty.
   * Does not require start() -- works directly against the database and IMAP.
   * Returns the total number of entries processed.
   */
  async drain(accountId: string): Promise<number> {
    const wasRunning = this.running;
    this.running = true;
    try {
      let totalProcessed = 0;
      while (true) {
        const processed = await this.processBatch(accountId);
        if (processed === 0) break;
        totalProcessed += processed;
      }
      return totalProcessed;
    } finally {
      this.running = wasRunning;
    }
  }

  /** Process a batch of sync_queue entries for an account */
  private async processBatch(accountId: string): Promise<number> {
    // Fetch pending entries with message data joined
    const rows = await sql<QueueEntry>`
      SELECT sq.id, sq.account_id, sq.message_id,
             COALESCE(sq.folder_id, m.folder_id) AS folder_id,
             sq.action, sq.payload, sq.status, sq.attempts, sq.max_attempts,
             sq.error, sq.created_at, sq.processed_at, sq.next_retry_at,
             m.imap_uid, m.modseq
      FROM sync_queue sq
      LEFT JOIN messages m ON sq.message_id = m.id
      WHERE sq.account_id = ${accountId}
        AND sq.status IN ('pending', 'failed')
        AND sq.next_retry_at <= now()
      ORDER BY sq.created_at
      FOR UPDATE OF sq SKIP LOCKED
      LIMIT ${sql.lit(BATCH_SIZE)}
    `.execute(this.db);

    if (rows.rows.length === 0) return 0;

    log.debug({ accountId, count: rows.rows.length }, "Processing outbound batch");

    // Mark all fetched entries as 'processing' before IMAP operations
    const allIds = rows.rows.map((e) => e.id);
    await this.db
      .updateTable("sync_queue")
      .set({ status: "processing" })
      .where("id", "in", allIds)
      .execute();

    // Coalesce entries to reduce redundant IMAP operations
    const { effective, superseded } = coalesce(rows.rows);

    // Mark superseded entries as completed
    if (superseded.length > 0) {
      const supersededIds = superseded.map((e) => e.id);
      await this.db
        .updateTable("sync_queue")
        .set({ status: "completed", processed_at: new Date() })
        .where("id", "in", supersededIds)
        .execute();

      // Log coalesced entries to sync_audit
      for (const entry of superseded) {
        await this.logAudit(accountId, entry, { coalesced: true });
      }
    }

    // Process each effective entry
    for (const entry of effective) {
      if (!this.running) break;
      await this.processEntry(accountId, entry);
    }

    return rows.rows.length;
  }

  /** Process a single sync_queue entry */
  private async processEntry(accountId: string, entry: QueueEntry): Promise<void> {
    // Validate we have the message data needed for IMAP operations
    if (!entry.imap_uid) {
      log.warn(
        { entryId: entry.id, messageId: entry.message_id },
        "No imap_uid found for sync_queue entry; marking dead",
      );
      await this.markDead(entry, "No imap_uid available (message may have been deleted)");
      return;
    }

    const imapUid = Number(entry.imap_uid);
    const capabilities = await this.getCapabilities(accountId);
    if (!capabilities) {
      log.warn({ accountId }, "No capabilities found, skipping batch");
      await this.markFailed(entry, "No server capabilities cached");
      return;
    }

    try {
      const client = this.getImapClient(accountId);
      const flow = client.client;

      // Select the correct folder before operating on UIDs
      const folderId = entry.folder_id ?? (entry.payload as { folder_id?: string }).folder_id;
      const folderImapName = folderId ? await this.getFolderImapName(folderId) : null;

      if (!folderImapName && entry.action !== "delete") {
        // For non-delete operations, we need to know the folder
        await this.markFailed(entry, "Cannot resolve folder IMAP name");
        return;
      }

      let success = false;

      switch (entry.action) {
        case "flag_add":
        case "flag_remove": {
          const flag = (entry.payload as { flag?: string }).flag;
          if (!flag) {
            await this.markDead(entry, "Missing flag in payload");
            return;
          }

          // Select the folder where the message lives
          if (folderImapName) {
            const lock = await client.getMailboxLock(folderImapName);
            try {
              const modseq = entry.modseq ? BigInt(entry.modseq) : undefined;
              const result = await syncFlagToImap(
                flow,
                imapUid,
                entry.action,
                flag,
                capabilities,
                modseq,
              );

              if (result.conflict) {
                // CONDSTORE conflict: let inbound sync resolve
                await this.markCompleted(entry);
                await this.logAudit(accountId, entry, { conflict: true });
                return;
              }

              success = result.success;
            } finally {
              lock.release();
            }
          }
          break;
        }

        case "move": {
          const payload = entry.payload as {
            from_folder_id?: string;
            to_folder_id?: string;
          };

          const fromFolderName = payload.from_folder_id
            ? await this.getFolderImapName(payload.from_folder_id)
            : null;
          const toFolderName = payload.to_folder_id
            ? await this.getFolderImapName(payload.to_folder_id)
            : null;

          if (!fromFolderName || !toFolderName) {
            await this.markFailed(entry, "Cannot resolve source or target folder IMAP name");
            return;
          }

          const lock = await client.getMailboxLock(fromFolderName);
          try {
            const result = await moveMessage(flow, imapUid, toFolderName, capabilities);
            success = result.success;

            if (result.success && result.newUid != null && entry.message_id) {
              // Update the message's imap_uid to the new UID in the target folder
              await this.db
                .updateTable("messages")
                .set({
                  imap_uid: String(result.newUid),
                  sync_version: sql`sync_version + 1`,
                })
                .where("id", "=", entry.message_id)
                .execute();
            }
          } finally {
            lock.release();
          }
          break;
        }

        case "delete": {
          // Resolve folder from payload (soft delete trigger stores it)
          const deletePayload = entry.payload as { folder_id?: string; imap_uid?: string };
          const deleteFolderName = deletePayload.folder_id
            ? await this.getFolderImapName(deletePayload.folder_id)
            : folderImapName;
          const deleteUid = deletePayload.imap_uid ? Number(deletePayload.imap_uid) : imapUid;

          if (!deleteFolderName) {
            await this.markFailed(entry, "Cannot resolve folder IMAP name for delete");
            return;
          }

          const lock = await client.getMailboxLock(deleteFolderName);
          try {
            const result = await deleteMessage(flow, deleteUid);
            success = result.success;
          } finally {
            lock.release();
          }
          break;
        }

        default:
          await this.markDead(entry, `Unknown action: ${entry.action}`);
          return;
      }

      if (success) {
        await this.markCompleted(entry);

        // Bump sync_version on the message to prevent inbound re-import
        if (entry.message_id && entry.action !== "move") {
          await this.db
            .updateTable("messages")
            .set({ sync_version: sql`sync_version + 1` })
            .where("id", "=", entry.message_id)
            .execute();
        }

        await this.logAudit(accountId, entry);
      } else {
        await this.markFailed(entry, "IMAP operation returned false");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, entryId: entry.id, action: entry.action }, "IMAP operation failed");
      await this.markFailed(entry, errMsg);
    }
  }

  /** Mark a sync_queue entry as completed */
  private async markCompleted(entry: QueueEntry): Promise<void> {
    await this.db
      .updateTable("sync_queue")
      .set({ status: "completed", processed_at: new Date() })
      .where("id", "=", entry.id)
      .execute();
  }

  /** Mark a sync_queue entry as failed with retry backoff or escalate to dead */
  private async markFailed(entry: QueueEntry, error: string): Promise<void> {
    const newAttempts = entry.attempts + 1;

    if (newAttempts >= entry.max_attempts) {
      await this.markDead(entry, error);
      return;
    }

    const delay = computeDelay(newAttempts, {
      maxRetries: entry.max_attempts,
      baseDelay: 1_000,
      maxDelay: 300_000,
      jitter: true,
    });

    const nextRetry = new Date(Date.now() + delay);

    await this.db
      .updateTable("sync_queue")
      .set({
        status: "failed",
        attempts: newAttempts,
        error,
        next_retry_at: nextRetry,
      })
      .where("id", "=", entry.id)
      .execute();

    log.warn(
      { entryId: entry.id, attempts: newAttempts, nextRetryAt: nextRetry.toISOString(), error },
      "Sync queue entry failed, will retry",
    );
  }

  /** Mark a sync_queue entry as dead (exhausted retries) */
  private async markDead(entry: QueueEntry, error: string): Promise<void> {
    await this.db
      .updateTable("sync_queue")
      .set({
        status: "dead",
        attempts: entry.attempts + 1,
        error,
        processed_at: new Date(),
      })
      .where("id", "=", entry.id)
      .execute();

    await this.logAudit(entry.account_id, entry, { dead: true, error });

    log.error(
      { entryId: entry.id, action: entry.action, error },
      "Sync queue entry dead-lettered after max attempts",
    );
  }

  /** Look up imap_name from folder UUID */
  private async getFolderImapName(folderId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("folders")
      .select("imap_name")
      .where("id", "=", folderId)
      .executeTakeFirst();
    return row?.imap_name ?? null;
  }

  /** Write to sync_audit table */
  private async logAudit(
    accountId: string,
    entry: QueueEntry,
    extraDetail?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const detail = extraDetail ? JSON.stringify(extraDetail) : null;

      await this.db
        .insertInto("sync_audit")
        .values({
          account_id: accountId,
          direction: extraDetail?.conflict ? "conflict" : "outbound",
          action: entry.action,
          message_id: entry.message_id,
          folder_id: entry.folder_id,
          detail,
        })
        .execute();
    } catch (err) {
      log.error({ err, entryId: entry.id }, "Failed to write sync_audit");
    }
  }
}
