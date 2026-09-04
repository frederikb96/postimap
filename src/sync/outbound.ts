import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import type { ImapClient } from "../imap/pool.js";
import { deleteMessages } from "../protocol/delete-handler.js";
import { syncFlagsToImapBatch, syncFlagToImap } from "../protocol/flag-sync.js";
import { createFolder, deleteFolder } from "../protocol/folder-ops.js";
import { updateFlags } from "../protocol/message-sync.js";
import { moveMessages } from "../protocol/move-handler.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import { type ResolvedTarget, resolveTarget } from "./queue-resolution.js";

const log = createLogger("outbound-sync");

/**
 * Default number of `sync_queue` rows claimed per DB round trip. Larger than it looks
 * necessary to be on its own -- the real throughput comes from grouping a claimed batch
 * into one IMAP command per (action, folder, flag/target) rather than one per message, so
 * a bigger claim means more messages that can land in the same command. Configurable via
 * `sync.outbound_batch_size` for a deployment whose IMAP server has a tighter command-line
 * length limit.
 */
const DEFAULT_BATCH_SIZE = 500;

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

/** A queue entry paired with what it resolved to -- everything a group needs to act. */
interface ResolvedEntry {
  entry: QueueEntry;
  target: Extract<ResolvedTarget, { resolved: true }>;
}

interface MovePayload {
  from_folder_id?: string;
  to_folder_id?: string;
  old_imap_uid?: string | null;
}

/**
 * Chronological order, `id` (a `BIGINT GENERATED ALWAYS AS IDENTITY`, so strictly
 * insertion-ordered) breaking the tie. Every row a single consumer transaction enqueues
 * shares its `created_at` -- `now()` inside one transaction never advances -- so ordering
 * on the timestamp alone leaves their relative order unspecified, and coalescing them in
 * the wrong order picks the wrong source for a chained move.
 */
function compareQueueOrder(a: QueueEntry, b: QueueEntry): number {
  const byTime = a.created_at.getTime() - b.created_at.getTime();
  if (byTime !== 0) return byTime;
  const aId = BigInt(a.id);
  const bId = BigInt(b.id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
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
    // Sort ascending so the last entry is the most recent
    group.sort(compareQueueOrder);

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
  effective.sort(compareQueueOrder);

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

/** Groups items by a string key, preserving each item's position within its group. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

/**
 * Outbound sync processor: consumes sync_queue entries and applies them to IMAP.
 *
 * Wakeup via PG LISTEN/NOTIFY per account, with polling fallback.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent processing.
 *
 * A wakeup drains the account's whole backlog rather than one claimed batch: the queue is
 * a moving target during a large backlog, and stopping after one claim relied on the next
 * wakeup to keep going. Every wakeup competing for the same account collapses into the one
 * already draining it (the `processing` guard), and while a backlog is being drained no
 * other wakeup arrives to take over, so a five-second poll interval used to be the only
 * thing pulling the next batch through.
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
    private batchSize: number = DEFAULT_BATCH_SIZE,
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

  /** Schedule a full drain of an account's queue (debounced per account) */
  private scheduleBatch(accountId: string): void {
    if (!this.running) return;
    // Prevent concurrent processing for the same account
    if (this.processing.has(accountId)) return;

    this.processing.add(accountId);
    this.drainAccount(accountId)
      .catch((err) => {
        log.error({ err, accountId }, "Batch processing failed");
      })
      .finally(() => {
        this.processing.delete(accountId);
      });
  }

  /**
   * Process claimed batches back to back, with no wait between them, until a claim comes
   * back empty. This is what turns "one batch per wakeup" into "the whole backlog before
   * this wakeup gives up ownership" -- a notification or poll tick that lands while this
   * is running is dropped by the `processing` guard rather than queued, so nothing else
   * would otherwise pick the queue back up until it fires again.
   */
  private async drainAccount(accountId: string): Promise<number> {
    let total = 0;
    while (this.running) {
      const processed = await this.processBatch(accountId);
      if (processed === 0) break;
      total += processed;
    }
    return total;
  }

  /**
   * Synchronously process ALL pending queue entries for an account until the queue is
   * empty. Does not require start() -- works directly against the database and IMAP.
   * Returns the total number of entries processed.
   */
  async drain(accountId: string): Promise<number> {
    const wasRunning = this.running;
    this.running = true;
    try {
      return await this.drainAccount(accountId);
    } finally {
      this.running = wasRunning;
    }
  }

  /** Claim and process one batch of sync_queue entries for an account */
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
        ORDER BY sq.created_at, sq.id
        FOR UPDATE OF sq SKIP LOCKED
        LIMIT ${sql.lit(this.batchSize)}
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
      await this.logAuditBatch(accountId, superseded, { coalesced: true });
    }

    // A folder action carries no message, so every message-shaped step below -- the
    // imap_uid refresh, target resolution, the mailbox lock around a UID operation --
    // would reject it on a property it is not supposed to have.
    const folderEntries = effective.filter((e) => OutboundProcessor.isFolderAction(e.action));
    const messageEntries = effective.filter((e) => !OutboundProcessor.isFolderAction(e.action));

    for (const entry of folderEntries) {
      if (!this.running) break;
      await this.processFolderEntry(accountId, entry);
    }

    if (this.running && messageEntries.length > 0) {
      await this.processMessageEntries(accountId, messageEntries);
    }

    return claimed.length;
  }

  /** True for actions that operate on a mailbox rather than on a message. */
  private static isFolderAction(action: string): boolean {
    return action === "folder_create" || action === "folder_delete";
  }

  /**
   * Resolve, group and apply every message-shaped entry from one claimed batch.
   *
   * Moves are resolved and applied first, in their own pass, before flags and deletes are
   * even resolved. A flag change queued after a move for the same message has no UID of
   * its own -- it reads wherever the message physically is -- and the only place that is
   * true is the row a completed move just wrote back. Resolving everything from one
   * upfront snapshot would race that: the flag's target would still see the pre-move NULL
   * this same batch is about to clear. Splitting into two passes with a fresh read of
   * `messages` between them keeps that ordering without going back to one entry at a time.
   */
  private async processMessageEntries(accountId: string, entries: QueueEntry[]): Promise<void> {
    const moveEntries = entries.filter((e) => e.action === "move");
    const otherEntries = entries.filter((e) => e.action !== "move");

    const moveResolved = await this.resolveEntries(moveEntries);
    if (moveResolved.length > 0) {
      const capabilities = await this.getCapabilities(accountId);
      if (!capabilities) {
        log.warn({ accountId }, "No capabilities found, skipping batch");
        for (const { entry } of moveResolved) {
          await this.markFailed(entry, "No server capabilities cached");
        }
      } else {
        await this.processResolvedMoves(accountId, moveResolved, capabilities);
      }
    }

    if (!this.running) return;

    // Re-read fresh: phase one may just have written back UIDs this phase's own entries
    // depend on.
    const otherResolved = await this.resolveEntries(otherEntries);
    if (otherResolved.length > 0) {
      const capabilities = await this.getCapabilities(accountId);
      if (!capabilities) {
        log.warn({ accountId }, "No capabilities found, skipping batch");
        for (const { entry } of otherResolved) {
          await this.markFailed(entry, "No server capabilities cached");
        }
      } else {
        await this.processResolvedFlagsAndDeletes(accountId, otherResolved, capabilities);
      }
    }
  }

  /**
   * Resolve what each entry acts on, from one batched read of current `messages` state
   * rather than one SELECT per entry. Unresolvable entries are settled here (failed or
   * dead-lettered) and excluded from the result.
   */
  private async resolveEntries(entries: QueueEntry[]): Promise<ResolvedEntry[]> {
    if (entries.length === 0) return [];

    const messageIds = [
      ...new Set(entries.map((e) => e.message_id).filter((id): id is string => id !== null)),
    ];
    const fresh = await this.getMessageUids(messageIds);

    const resolved: ResolvedEntry[] = [];
    for (const original of entries) {
      const current = original.message_id ? (fresh.get(original.message_id) ?? null) : null;
      const entry = current
        ? { ...original, imap_uid: current.imap_uid, modseq: current.modseq }
        : original;

      const target = resolveTarget(entry);
      if (!target.resolved) {
        // A message row that still exists can gain a UID later -- the move ahead of this
        // entry has not written one back yet -- so that is a retry, not a verdict.
        // Nothing left to resolve from is terminal.
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
        continue;
      }

      resolved.push({ entry, target });
    }
    return resolved;
  }

  /** The current `imap_uid`/`modseq` for a set of messages, in one round trip. */
  private async getMessageUids(
    messageIds: string[],
  ): Promise<Map<string, { imap_uid: string | null; modseq: string | null }>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("messages")
      .select(["id", "imap_uid", "modseq"])
      .where("id", "in", messageIds)
      .execute();
    return new Map(rows.map((r) => [r.id, { imap_uid: r.imap_uid, modseq: r.modseq }]));
  }

  /** Group resolved moves by (source folder, destination folder) and apply each group. */
  private async processResolvedMoves(
    accountId: string,
    resolved: ResolvedEntry[],
    capabilities: ServerCapabilities,
  ): Promise<void> {
    const groups = groupBy(
      resolved,
      (r) => `${r.target.sourceFolderId}|${r.target.targetFolderId}`,
    );

    for (const group of groups.values()) {
      if (!this.running) return;
      await this.processMoveGroup(accountId, group, capabilities);
    }
  }

  /** One MOVE (or COPY+DELETE fallback) covering every UID in the group. */
  private async processMoveGroup(
    accountId: string,
    group: ResolvedEntry[],
    capabilities: ServerCapabilities,
  ): Promise<void> {
    const { sourceFolderId, targetFolderId } = group[0].target;
    const sourceFolderName = await this.getFolderImapName(sourceFolderId);
    if (!sourceFolderName) {
      for (const { entry } of group)
        await this.markFailed(entry, "Cannot resolve folder IMAP name");
      return;
    }
    const toFolderName = targetFolderId ? await this.getFolderImapName(targetFolderId) : null;
    if (!toFolderName) {
      for (const { entry } of group) {
        await this.markFailed(entry, "Cannot resolve target folder IMAP name");
      }
      return;
    }

    const client = this.getImapClient(accountId);
    const uids = group.map((g) => g.target.sourceUid);

    try {
      let result: Awaited<ReturnType<typeof moveMessages>>;
      const lock = await client.getMailboxLock(sourceFolderName);
      try {
        result = await moveMessages(client.client, uids, toFolderName, capabilities);
      } finally {
        lock.release();
      }

      if (!result.success) {
        for (const { entry } of group) {
          await this.markFailed(entry, "IMAP operation returned false");
        }
        return;
      }

      // A landed message writes back its new UID and completes in one batched pass; a
      // vanished one -- MOVE over a UID that matches nothing, which is not an IMAP error,
      // just an omission from uidMap -- is resolved on its own rather than the whole group
      // being marked failed for it.
      const landed: { entry: QueueEntry; newUid: number }[] = [];
      const vanished: QueueEntry[] = [];
      for (const { entry, target } of group) {
        const newUid = result.uidMap.get(target.sourceUid);
        if (newUid != null && entry.message_id) {
          landed.push({ entry, newUid });
        } else {
          vanished.push(entry);
        }
      }

      if (landed.length > 0) {
        await this.writeBackMovedUidsBatch(
          landed.map(({ entry, newUid }) => ({ messageId: entry.message_id as string, newUid })),
        );
        const landedEntries = landed.map((l) => l.entry);
        await this.markCompletedBatch(landedEntries);
        await this.logAuditBatch(accountId, landedEntries);
      }

      for (const entry of vanished) {
        await this.reconcileVanishedMove(accountId, entry, toFolderName);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId, action: "move", count: group.length }, "IMAP operation failed");
      for (const { entry } of group) await this.markFailed(entry, errMsg);
    }
  }

  /** Group resolved flags and deletes, and apply each group. */
  private async processResolvedFlagsAndDeletes(
    accountId: string,
    resolved: ResolvedEntry[],
    capabilities: ServerCapabilities,
  ): Promise<void> {
    const flagEntries = resolved.filter(
      (r) => r.entry.action === "flag_add" || r.entry.action === "flag_remove",
    );
    const deleteEntries = resolved.filter((r) => r.entry.action === "delete");

    const flagGroups = groupBy(flagEntries, (r) => {
      const flag = (r.entry.payload as { flag?: string }).flag ?? "";
      return `${r.target.sourceFolderId}|${r.entry.action}|${flag}`;
    });
    for (const group of flagGroups.values()) {
      if (!this.running) return;
      await this.processFlagGroup(accountId, group, capabilities);
    }

    const deleteGroups = groupBy(deleteEntries, (r) => r.target.sourceFolderId);
    for (const group of deleteGroups.values()) {
      if (!this.running) return;
      await this.processDeleteGroup(accountId, group);
    }
  }

  /**
   * One STORE covering every UID in the group -- except a lone message, which keeps its
   * own CONDSTORE-guarded STORE so a genuine conflict still defers to inbound sync exactly
   * as it always has (see `syncFlagsToImapBatch` for why that doesn't generalize).
   */
  private async processFlagGroup(
    accountId: string,
    group: ResolvedEntry[],
    capabilities: ServerCapabilities,
  ): Promise<void> {
    const action = group[0].entry.action as "flag_add" | "flag_remove";
    const flag = (group[0].entry.payload as { flag?: string }).flag;
    if (!flag) {
      for (const { entry } of group) await this.markDead(entry, "Missing flag in payload");
      return;
    }

    const folderImapName = await this.getFolderImapName(group[0].target.sourceFolderId);
    if (!folderImapName) {
      for (const { entry } of group)
        await this.markFailed(entry, "Cannot resolve folder IMAP name");
      return;
    }

    const client = this.getImapClient(accountId);

    if (group.length === 1) {
      const { entry, target } = group[0];
      try {
        const lock = await client.getMailboxLock(folderImapName);
        try {
          const modseq = entry.modseq ? BigInt(entry.modseq) : undefined;
          const result = await syncFlagToImap(
            client.client,
            target.sourceUid,
            action,
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

          if (result.success) {
            await this.markCompleted(entry);
            await this.logAudit(accountId, entry);
          } else {
            await this.markFailed(entry, "IMAP operation returned false");
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ err, entryId: entry.id, action: entry.action }, "IMAP operation failed");
        await this.markFailed(entry, errMsg);
      }
      return;
    }

    const uids = group.map((g) => g.target.sourceUid);
    try {
      let result: Awaited<ReturnType<typeof syncFlagsToImapBatch>>;
      const lock = await client.getMailboxLock(folderImapName);
      try {
        result = await syncFlagsToImapBatch(client.client, uids, action, flag);
      } finally {
        lock.release();
      }

      if (result.success) {
        const entries = group.map((g) => g.entry);
        await this.markCompletedBatch(entries);
        await this.logAuditBatch(accountId, entries);
      } else {
        for (const { entry } of group)
          await this.markFailed(entry, "IMAP operation returned false");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId, action, count: group.length }, "IMAP operation failed");
      for (const { entry } of group) await this.markFailed(entry, errMsg);
    }
  }

  /** One DELETE (STORE \Deleted + EXPUNGE) covering every UID in the group. */
  private async processDeleteGroup(accountId: string, group: ResolvedEntry[]): Promise<void> {
    const folderImapName = await this.getFolderImapName(group[0].target.sourceFolderId);
    if (!folderImapName) {
      for (const { entry } of group)
        await this.markFailed(entry, "Cannot resolve folder IMAP name");
      return;
    }

    const client = this.getImapClient(accountId);
    const uids = group.map((g) => g.target.sourceUid);

    try {
      const lock = await client.getMailboxLock(folderImapName);
      try {
        await deleteMessages(client.client, uids);
      } finally {
        lock.release();
      }

      const entries = group.map((g) => g.entry);
      await this.markCompletedBatch(entries);
      await this.logAuditBatch(accountId, entries);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId, action: "delete", count: group.length }, "IMAP operation failed");
      for (const { entry } of group) await this.markFailed(entry, errMsg);
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
   * The UID write-back for a whole group of successful moves, in one statement rather
   * than one UPDATE per message. Each row gets a different value, so this needs a
   * VALUES list rather than a single SET -- a plain `WHERE id = ANY(...)` can only write
   * the same value to every row it matches.
   */
  private async writeBackMovedUidsBatch(
    updates: { messageId: string; newUid: number }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    await withSyncWriter(this.db, (trx) =>
      sql`
        UPDATE messages AS m
        SET imap_uid = v.uid
        FROM (VALUES ${sql.join(
          updates.map((u) => sql`(${u.messageId}::uuid, ${String(u.newUid)}::bigint)`),
        )}) AS v(id, uid)
        WHERE m.id = v.id
      `.execute(trx),
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
    const headerId = entry.message_id
      ? ((await this.getMessageIdentity(entry.message_id))?.message_id ?? null)
      : null;
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

  /**
   * Mark many sync_queue entries as completed in one statement. What actually made a
   * grouped IMAP command worth doing: without this, a group of N entries still cost N
   * sequential round trips to mark them done and audit them, which dominates once the
   * IMAP call itself is down to one -- N messages otherwise finishing IMAP-fast and then
   * spending seconds walking sync_queue and sync_audit one row at a time.
   */
  private async markCompletedBatch(entries: QueueEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db
      .updateTable("sync_queue")
      .set({ status: "completed", processed_at: new Date(), error: null })
      .where(
        "id",
        "in",
        entries.map((e) => e.id),
      )
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
    await this.recordFailedWrite(entry, error);

    log.error(
      { entryId: entry.id, action: entry.action, error },
      "Sync queue entry dead-lettered after max attempts",
    );
  }

  /**
   * Keep a durable record of a write that will never reach the server, then correct the
   * mirror.
   *
   * The consumer's value is still sitting in the column it wrote. Waiting for the next
   * poll to overwrite it leaves an unbounded window where PG claims something about the
   * message that the server does not agree with, so the folder is re-read straight away
   * and `reverted_at` records that it was.
   */
  private async recordFailedWrite(entry: QueueEntry, error: string): Promise<void> {
    const target = resolveTarget(entry);
    const folderId = target.resolved ? target.sourceFolderId : entry.folder_id;
    const identity = entry.message_id ? await this.getMessageIdentity(entry.message_id) : null;

    let notificationId: string;
    try {
      const row = await withSyncWriter(this.db, (trx) =>
        trx
          .insertInto("sync_notifications")
          .values({
            account_id: entry.account_id,
            action: entry.action,
            message_id: entry.message_id,
            folder_id: folderId,
            error,
            detail: {
              attempted: entry.payload,
              attempts: entry.attempts + 1,
              // Captured rather than joined: retention removes an expunged message well
              // before it removes this row, and a bare UUID renders as nothing.
              header_message_id: identity?.message_id ?? null,
              subject: identity?.subject ?? null,
            },
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
      notificationId = String(row.id);
    } catch (err) {
      log.error({ err, entryId: entry.id }, "Failed to record a dead-lettered write");
      return;
    }

    try {
      if (await this.revertFailedWrite(entry, target)) {
        await this.db
          .updateTable("sync_notifications")
          .set({ reverted_at: new Date() })
          .where("id", "=", notificationId)
          .execute();
      }
    } catch (err) {
      // The notification stands either way. Leaving reverted_at null is the honest
      // outcome: the consumer's value is still in the column and nothing has checked it
      // against the server yet.
      log.warn({ err, entryId: entry.id, folderId }, "Could not correct the mirror");
    }
  }

  /**
   * Put the mirror back to what the server actually holds, for this one operation.
   *
   * A general folder resync would not do it. The server never saw the write, so on a
   * CONDSTORE or QRESYNC tier there is no change for it to report and change detection
   * finds nothing to correct -- the divergence would survive every sync until something
   * else happened to that message. So each action is undone by name, against the state the
   * server is holding right now.
   *
   * Returns whether the mirror was actually checked against the server.
   */
  private async revertFailedWrite(entry: QueueEntry, target: ResolvedTarget): Promise<boolean> {
    if (!entry.message_id || !target.resolved) return false;

    switch (entry.action) {
      case "move": {
        // The app wrote the destination folder and cleared the UID, so the row has to go
        // back to where the message physically is -- but only after checking that it is
        // still there. A move can dead-letter because the server refused it, in which case
        // the message never left; it can also dead-letter because the message was found in
        // neither folder, in which case that UID names nothing and writing it back would
        // point the row at a phantom while `reverted_at` claimed the state had been
        // verified.
        const folderImapName = await this.getFolderImapName(target.sourceFolderId);
        if (!folderImapName) return false;

        const client = this.getImapClient(entry.account_id);
        const lock = await client.getMailboxLock(folderImapName);
        let stillThere = false;
        try {
          const found = await client.client.fetchOne(
            String(target.sourceUid),
            { uid: true },
            { uid: true },
          );
          stillThere = found !== false;
        } finally {
          lock.release();
        }
        if (!stillThere) return false;

        await withSyncWriter(this.db, (trx) =>
          trx
            .updateTable("messages")
            .set({
              folder_id: target.sourceFolderId,
              imap_uid: String(target.sourceUid),
            })
            .where("id", "=", entry.message_id as string)
            .execute(),
        );
        return true;
      }

      case "delete": {
        await withSyncWriter(this.db, (trx) =>
          trx
            .updateTable("messages")
            .set({ expunged_at: null })
            .where("id", "=", entry.message_id as string)
            .execute(),
        );
        return true;
      }

      case "flag_add":
      case "flag_remove": {
        const folderImapName = await this.getFolderImapName(target.sourceFolderId);
        if (!folderImapName) return false;

        const client = this.getImapClient(entry.account_id);
        const lock = await client.getMailboxLock(folderImapName);
        let flags: Set<string> | null = null;
        try {
          const message = await client.client.fetchOne(
            String(target.sourceUid),
            { flags: true },
            { uid: true },
          );
          if (message !== false && message.flags) flags = message.flags;
        } finally {
          lock.release();
        }
        if (!flags) return false;

        await updateFlags(this.db, target.sourceFolderId, [{ uid: target.sourceUid, flags }]);
        return true;
      }

      default:
        // A folder create or delete that was abandoned needs nothing here: the row no
        // longer excludes itself from reconciliation, so the next LIST puts it right.
        return false;
    }
  }

  /**
   * The RFC 5322 Message-ID and subject. The header id survives a move where a UID does
   * not, and both survive in a notification after the row itself is purged.
   */
  private async getMessageIdentity(
    messageId: string,
  ): Promise<{ message_id: string | null; subject: string | null } | null> {
    const row = await this.db
      .selectFrom("messages")
      .select(["message_id", "subject"])
      .where("id", "=", messageId)
      .executeTakeFirst();
    return row ?? null;
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

  /** Write one sync_audit row per entry, in a single multi-row INSERT. */
  private async logAuditBatch(
    accountId: string,
    entries: QueueEntry[],
    extraDetail?: Record<string, unknown>,
  ): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.db
        .insertInto("sync_audit")
        .values(
          entries.map((entry) => ({
            account_id: accountId,
            direction: extraDetail?.conflict ? "conflict" : ("outbound" as const),
            action: entry.action,
            message_id: entry.message_id,
            folder_id: entry.folder_id,
            detail: extraDetail ?? null,
          })),
        )
        .execute();
    } catch (err) {
      log.error({ err, accountId, count: entries.length }, "Failed to write sync_audit");
    }
  }
}
