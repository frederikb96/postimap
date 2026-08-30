import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import type { ImapClient } from "../imap/pool.js";
import { deleteMessage } from "../protocol/delete-handler.js";
import { syncFlagToImap } from "../protocol/flag-sync.js";
import { createFolder, deleteFolder } from "../protocol/folder-ops.js";
import { moveMessage } from "../protocol/move-handler.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import { resolveTarget } from "./queue-resolution.js";

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

interface MovePayload {
  from_folder_id?: string;
  to_folder_id?: string;
  old_imap_uid?: string | null;
}

export interface CoalesceResult {
  effective: QueueEntry[];
  superseded: QueueEntry[];
}

/**
 * Coalesce a batch of sync_queue entries to eliminate redundant IMAP operations.
 *
 * Groups by message and keeps the net effect:
 * - flag_add/flag_remove on the same flag: only the LAST entry wins
 * - move: one synthesized entry from the FIRST move's source and the LAST move's
 *   destination -- A->B->C is A->C
 * - delete: supersedes all prior flag/move entries for that message, taking its source
 *   from the earliest entry that names one
 *
 * The source has to come from the earliest entry because an optimistic move nulls
 * `messages.imap_uid`, so every trigger firing after the first one captures NULL. Picking
 * the last entry -- the intuitive coalescing rule -- yields an operation with nothing to
 * act on, and none of the moves reach the server at all. Within a batch none of these
 * have run yet, so the message is still where the first entry said it was.
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

    const moveEntriesInGroup = group.filter((e) => e.action === "move");
    const firstMove = moveEntriesInGroup[0];

    // If any entry is a delete, it supersedes all others for this message
    const lastDelete = [...group].reverse().find((e) => e.action === "delete");
    if (lastDelete) {
      effective.push(withDeleteSource(lastDelete, firstMove));
      for (const entry of group) {
        if (entry.id !== lastDelete.id) {
          superseded.push(entry);
        }
      }
      continue;
    }

    // Group flag entries by (action, flag) key; keep only the last per flag
    const flagEntries = group.filter((e) => e.action === "flag_add" || e.action === "flag_remove");
    const moveEntries = moveEntriesInGroup;

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

    // For moves: one hop from where the message actually is to where it should end up
    if (moveEntries.length > 0) {
      const lastMove = moveEntries[moveEntries.length - 1];
      effective.push(mergeMoves(moveEntries));
      for (const entry of moveEntries) {
        if (entry.id !== lastMove.id) {
          superseded.push(entry);
        }
      }
    }
  }

  // Apply in the order the consumer wrote them. A flag change queued after a move has no
  // UID of its own and reads the message row, which only names the right one once the
  // move has run and written the server's new UID back.
  effective.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  return { effective, superseded };
}

/** The net move: the first entry's origin, the last entry's destination. */
function mergeMoves(moveEntries: QueueEntry[]): QueueEntry {
  const first = moveEntries[0];
  const last = moveEntries[moveEntries.length - 1];
  if (first.id === last.id) return last;

  const firstPayload = first.payload as MovePayload;
  const lastPayload = last.payload as MovePayload;
  return {
    ...last,
    payload: {
      ...lastPayload,
      from_folder_id: firstPayload.from_folder_id,
      old_imap_uid: firstPayload.old_imap_uid,
    },
  };
}

/**
 * A delete that supersedes a move has to act on the message where it still physically is
 * -- the source of the first move -- since the move it supersedes never ran.
 */
function withDeleteSource(deleteEntry: QueueEntry, firstMove: QueueEntry | undefined): QueueEntry {
  if (!firstMove) return deleteEntry;

  const movePayload = firstMove.payload as MovePayload;
  if (movePayload.old_imap_uid == null) return deleteEntry;

  return {
    ...deleteEntry,
    payload: {
      ...(deleteEntry.payload as Record<string, unknown>),
      imap_uid: movePayload.old_imap_uid,
      folder_id: movePayload.from_folder_id,
    },
  };
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
    _maxRetryAttempts: number,
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
    // Claim a batch: SELECT ... FOR UPDATE SKIP LOCKED and the status='processing' mark
    // run in one transaction, so the row lock covers both statements. Two workers racing
    // this concurrently cannot both claim the same row -- previously the lock was
    // released (autocommit) between the two statements, making SKIP LOCKED decorative.
    const claimed = await this.db.transaction().execute(async (trx) => {
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
      `.execute(trx);

      if (rows.rows.length === 0) return [];

      const allIds = rows.rows.map((e) => e.id);
      await trx
        .updateTable("sync_queue")
        .set({ status: "processing" })
        .where("id", "in", allIds)
        .execute();

      return rows.rows;
    });

    if (claimed.length === 0) return 0;

    log.debug({ accountId, count: claimed.length }, "Processing outbound batch");

    // Coalesce entries to reduce redundant IMAP operations
    const { effective, superseded } = coalesce(claimed);

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

    return claimed.length;
  }

  /** True for actions that operate on a mailbox rather than on a message. */
  private static isFolderAction(action: string): boolean {
    return action === "folder_create" || action === "folder_delete";
  }

  /** Process a single sync_queue entry */
  private async processEntry(accountId: string, entry: QueueEntry): Promise<void> {
    // A folder action carries no message, so every message-shaped guard below -- the
    // imap_uid check, the cached-capabilities check, the mailbox lock around a UID
    // operation -- would reject it on a property it is not supposed to have.
    if (OutboundProcessor.isFolderAction(entry.action)) {
      await this.processFolderEntry(accountId, entry);
      return;
    }

    // Re-read the message rather than trusting the join taken when the batch was claimed.
    // An earlier entry in this same batch may have been a move, which writes the server's
    // new UID back on success -- the claim-time snapshot still holds the NULL the app set.
    const current = entry.message_id ? await this.getMessageUid(entry.message_id) : null;
    if (current) {
      entry = { ...entry, imap_uid: current.imap_uid, modseq: current.modseq };
    }

    const target = resolveTarget(entry);
    if (!target.resolved) {
      // A message row that still exists can gain a UID later -- the move ahead of this
      // entry has not written one back yet -- so that is a retry, not a verdict. Nothing
      // left to resolve from is terminal.
      const recoverable = current !== null;
      log.warn(
        { entryId: entry.id, messageId: entry.message_id, action: entry.action, recoverable },
        "Cannot resolve what a sync_queue entry acts on",
      );
      if (recoverable) {
        await this.markFailed(entry, target.unresolved);
      } else {
        await this.markDead(entry, `${target.unresolved} (message row is gone)`);
      }
      return;
    }

    const imapUid = target.sourceUid;
    const capabilities = await this.getCapabilities(accountId);

    if (!capabilities) {
      log.warn({ accountId }, "No capabilities found, skipping batch");
      await this.markFailed(entry, "No server capabilities cached");
      return;
    }

    try {
      const client = this.getImapClient(accountId);
      const flow = client.client;

      // Every action names its source folder through the same resolution, so a payload
      // whose keys differ from the generic ones -- a move carries from_folder_id, not
      // folder_id -- is no longer rejected by a guard that only knew how to read a flag
      // entry's shape.
      const folderImapName = await this.getFolderImapName(target.sourceFolderId);
      if (!folderImapName) {
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
          break;
        }

        case "move": {
          const toFolderName = target.targetFolderId
            ? await this.getFolderImapName(target.targetFolderId)
            : null;
          if (!toFolderName) {
            await this.markFailed(entry, "Cannot resolve target folder IMAP name");
            return;
          }

          let landedNowhere = false;
          const lock = await client.getMailboxLock(folderImapName);
          try {
            const result = await moveMessage(flow, imapUid, toFolderName, capabilities);
            success = result.success;

            if (result.success && result.newUid != null && entry.message_id) {
              await this.writeBackMovedUid(entry.message_id, result.newUid);
            } else if (result.success) {
              landedNowhere = true;
            }
          } finally {
            lock.release();
          }

          if (landedNowhere) {
            // MOVE over a UID set that matches nothing is not an IMAP error -- ImapFlow
            // returns a result with an empty uidMap rather than false. So "success with
            // no new UID" means the message was not in the source folder, which is
            // exactly what a retry sees after a crash between the server-side move and
            // the write-back that records it. Completing here would leave imap_uid NULL
            // forever, with every later operation on that row unable to name it, and
            // report the whole thing as a success.
            await this.reconcileVanishedMove(accountId, entry, toFolderName);
            return;
          }
          break;
        }

        case "delete": {
          const lock = await client.getMailboxLock(folderImapName);
          try {
            const result = await deleteMessage(flow, imapUid);
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

  /**
   * Apply a mailbox-level action. The name comes from the payload captured at enqueue
   * time rather than from the row: a delete tombstones the folder, and retention
   * eventually removes it, so the row is not guaranteed to still be there.
   */
  private async processFolderEntry(accountId: string, entry: QueueEntry): Promise<void> {
    const imapName = (entry.payload as { imap_name?: string }).imap_name;
    if (!imapName) {
      await this.markDead(entry, "Missing imap_name in payload");
      return;
    }

    try {
      const flow = this.getImapClient(accountId).client;
      const result =
        entry.action === "folder_create"
          ? await createFolder(flow, imapName)
          : await deleteFolder(flow, imapName);

      if (result.permanentError) {
        await this.markDead(entry, result.permanentError);
        return;
      }
      if (!result.success) {
        await this.markFailed(entry, "IMAP folder operation returned false");
        return;
      }

      if (entry.action === "folder_delete" && entry.folder_id) {
        await this.expungeDeletedFolderMessages(entry.folder_id);
      }

      await this.markCompleted(entry);
      await this.logAudit(accountId, entry);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, entryId: entry.id, action: entry.action, imapName }, "Folder op failed");
      await this.markFailed(entry, errMsg);
    }
  }

  /**
   * Mark every message in a just-deleted folder as expunged.
   *
   * IMAP DELETE destroys the mailbox and its mail outright, so those rows describe
   * messages that no longer exist anywhere. Left alone they stay `expunged_at IS NULL`
   * until retention hard-deletes the tombstoned folder and the FK cascade takes them --
   * a window in which the query every consumer is taught to trust, `expunged_at IS NULL`,
   * returns mail that is already gone. Reusing `expunged_at` keeps that one signal
   * authoritative instead of adding a second thing a consumer has to join against.
   *
   * This runs only here, on a delete the server confirmed. The reconciliation's own
   * soft-delete of a folder missing from LIST deliberately does not expunge: a partial or
   * flaky LIST is a plausible explanation there, which is exactly why that path
   * tombstones rather than destroys.
   *
   * Per-row events are suppressed. The consumer asked for this folder to go and already
   * has the folder event; a mailbox with tens of thousands of messages would otherwise
   * put one notification per message on the channel in a single transaction.
   */
  private async expungeDeletedFolderMessages(folderId: string): Promise<void> {
    const expungedAt = new Date();
    await withSyncWriter(
      this.db,
      (trx) =>
        trx
          .updateTable("messages")
          .set({ expunged_at: expungedAt })
          .where("folder_id", "=", folderId)
          .where("expunged_at", "is", null)
          .execute(),
      { backfill: true },
    );
  }

  /** Record the UID the server gave a moved message; completes the optimistic move. */
  private async writeBackMovedUid(messageId: string, newUid: number): Promise<void> {
    // Itself a sync-engine write, so it must not re-trigger move detection.
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("messages")
        .set({ imap_uid: String(newUid) })
        .where("id", "=", messageId)
        .execute(),
    );
  }

  /**
   * Work out what happened to a move the server accepted without naming a new UID.
   *
   * The message was not in the source folder. Either an earlier attempt already moved it
   * -- the crash-between-move-and-write-back case -- or it is gone entirely. Searching the
   * destination for its Message-ID separates the two, and only the first is a success.
   */
  private async reconcileVanishedMove(
    accountId: string,
    entry: QueueEntry,
    toFolderName: string,
  ): Promise<void> {
    const headerId = entry.message_id ? await this.getMessageHeaderId(entry.message_id) : null;
    if (!headerId || !entry.message_id) {
      await this.markFailed(
        entry,
        "Move matched no message in the source folder and the row has no Message-ID to find it by",
      );
      return;
    }

    const client = this.getImapClient(accountId);
    const lock = await client.getMailboxLock(toFolderName);
    let foundUid: number | null = null;
    try {
      const uids = await client.client.search(
        { header: { "message-id": headerId } },
        { uid: true },
      );
      if (uids && uids.length > 0) {
        foundUid = Math.max(...uids);
      }
    } finally {
      lock.release();
    }

    if (foundUid === null) {
      await this.markFailed(
        entry,
        "Move matched no message in the source folder and none in the target folder",
      );
      return;
    }

    await this.writeBackMovedUid(entry.message_id, foundUid);
    await this.markCompleted(entry);
    await this.logAudit(accountId, entry, { recoveredUid: foundUid });
    log.info(
      { entryId: entry.id, messageId: entry.message_id, foundUid, toFolderName },
      "Move had already been applied; recovered the message's UID in the target folder",
    );
  }

  /** Mark a sync_queue entry as completed */
  private async markCompleted(entry: QueueEntry): Promise<void> {
    await this.db
      .updateTable("sync_queue")
      .set({ status: "completed", processed_at: new Date(), error: null })
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
    // Giving up on an operation is the sync engine's own decision, and the sync_error
    // event this write fires reports its origin from the writer GUC like every other
    // event on the channel -- without the helper it would name the consumer as the
    // author of PostIMAP abandoning its work.
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("sync_queue")
        .set({
          status: "dead",
          attempts: entry.attempts + 1,
          error,
          processed_at: new Date(),
        })
        .where("id", "=", entry.id)
        .execute(),
    );

    await this.logAudit(entry.account_id, entry, { dead: true, error });

    log.error(
      { entryId: entry.id, action: entry.action, error },
      "Sync queue entry dead-lettered after max attempts",
    );
  }

  /** The message's UID and modseq as they are now, not as the batch claim saw them. */
  private async getMessageUid(
    messageId: string,
  ): Promise<{ imap_uid: string | null; modseq: string | null } | null> {
    const row = await this.db
      .selectFrom("messages")
      .select(["imap_uid", "modseq"])
      .where("id", "=", messageId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** The RFC 5322 Message-ID header, which survives a move where a UID does not. */
  private async getMessageHeaderId(messageId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("messages")
      .select("message_id")
      .where("id", "=", messageId)
      .executeTakeFirst();
    return row?.message_id ?? null;
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
      await this.db
        .insertInto("sync_audit")
        .values({
          account_id: accountId,
          direction: extraDetail?.conflict ? "conflict" : "outbound",
          action: entry.action,
          message_id: entry.message_id,
          folder_id: entry.folder_id,
          detail: extraDetail ?? null,
        })
        .execute();
    } catch (err) {
      log.error({ err, entryId: entry.id }, "Failed to write sync_audit");
    }
  }
}
