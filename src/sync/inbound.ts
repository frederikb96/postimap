import type { ExpungeEvent, FlagsEvent, MailboxObject, MailboxOpenOptions } from "imapflow";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { selectSyncTier } from "../imap/capabilities.js";
import type { ImapClient } from "../imap/pool.js";
import {
  expungeMessages,
  fetchAndStoreMessages,
  resetFolderMessages,
  updateFlags,
} from "../protocol/message-sync.js";
import { SyncAbortedError, throwIfAborted } from "../util/abort.js";
import { createLogger } from "../util/logger.js";
import {
  detectChanges,
  type FlagChange,
  type FolderState,
  type QresyncSelectEvents,
} from "./change-detector.js";
import { getPendingOutboundUids } from "./loop-guard.js";

const log = createLogger("inbound-sync");

/**
 * ImapFlow's public `MailboxOpenOptions` doesn't declare `changedSince`/`uidValidity` --
 * they're QRESYNC-only SELECT parameters read directly by the underlying SELECT command
 * (imapflow/lib/commands/select.js), not part of its documented API surface.
 */
interface QresyncSelectOptions extends MailboxOpenOptions {
  changedSince?: string;
  uidValidity?: bigint;
}

export interface SyncResult {
  newMessages: number;
  updatedFlags: number;
  deletedMessages: number;
  errors: string[];
  /**
   * True when the failure in `errors` came from a dead IMAP connection rather than
   * something scoped to this folder. Every remaining folder in the caller's cycle would
   * fail identically, so a multi-folder loop should abort on this instead of continuing.
   */
  connectionLost: boolean;
}

const EMPTY_RESULT: SyncResult = {
  newMessages: 0,
  updatedFlags: 0,
  deletedMessages: 0,
  errors: [],
  connectionLost: false,
};

/**
 * Orchestrates inbound sync (IMAP -> PG) for a single account.
 * Wires together change detection, message fetching, flag updates,
 * and folder state management.
 */
export class InboundSync {
  constructor(
    private client: ImapClient,
    private db: Kysely<Database>,
    private accountId: string,
    private capabilities: ServerCapabilities,
    /** Above this size a message is stored as envelope+flags only; see message-sync.ts. */
    private maxMessageBytes?: number,
  ) {}

  /**
   * Incremental sync for a single folder.
   * Uses three-tier change detection to identify what changed since last sync.
   */
  async syncFolder(
    folderId: string,
    folderImapName: string,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const result: SyncResult = { ...EMPTY_RESULT, errors: [] };

    try {
      throwIfAborted(signal);

      // 1. Get folder state from PG
      const folderState = await this.getFolderState(folderId);

      // 2. Get pending outbound UIDs (loop guard)
      const pendingUids = await getPendingOutboundUids(this.db, this.accountId, folderId);

      const tier = selectSyncTier(this.capabilities);

      // 3. Select folder on IMAP via mailbox lock
      const lock = await this.client.getMailboxLock(folderImapName);
      // A lock handle only checks whether *a* lock is held, not whether it is *this* one --
      // releasing it twice (once here on an early-return path, once in the enclosing
      // finally) can release a lock a nested fullSync() call just acquired for itself.
      // Guard with a flag so release only ever happens once.
      let lockReleased = false;
      const releaseLock = (): void => {
        if (!lockReleased) {
          lockReleased = true;
          lock.release();
        }
      };

      try {
        let mailbox = this.client.client.mailbox;
        if (!mailbox) {
          result.errors.push("Failed to open mailbox");
          return result;
        }

        // 3b. Real QRESYNC: force a second, parameterized SELECT so the server actually
        // sends VANISHED and changed-FETCH responses inline. getMailboxLock() above may
        // have taken its own fast path (folder already selected, no reselect at all) or a
        // plain reselect (no QRESYNC params) -- either way this is the SELECT that
        // matters for this tier, and it only runs once we have prior UIDVALIDITY and
        // HIGHESTMODSEQ to pin it to.
        let qresyncEvents: QresyncSelectEvents | undefined;
        if (
          tier === "qresync" &&
          folderState.uidvalidity !== null &&
          folderState.highestmodseq !== null
        ) {
          const reselected = await this.reselectForQresync(folderImapName, folderState);
          mailbox = reselected.mailbox;
          qresyncEvents = reselected.events;
        }

        // 4. Check UIDVALIDITY. The server renumbered UIDs -- an existing row's imap_uid
        // no longer identifies the same message, so the folder's messages are wiped
        // before refetching rather than upserted onto (and silently corrupting) old rows.
        if (folderState.uidvalidity !== null && mailbox.uidValidity !== folderState.uidvalidity) {
          log.warn(
            { folderId, folderImapName },
            "UIDVALIDITY changed, resetting folder and performing full resync",
          );
          releaseLock();
          await resetFolderMessages(this.db, folderId);
          return this.fullSync(folderId, folderImapName, false, signal);
        }

        // 5. Detect changes (three-tier)
        const changes = await detectChanges(
          this.client.client,
          folderState,
          tier,
          pendingUids,
          qresyncEvents,
        );

        if (changes.uidValidityChanged) {
          releaseLock();
          return this.fullSync(folderId, folderImapName, false, signal);
        }

        // 6. Fetch new messages (batched)
        if (changes.newUids.length > 0) {
          result.newMessages = await fetchAndStoreMessages(
            this.client.client,
            this.db,
            this.accountId,
            folderId,
            changes.newUids,
            { signal, maxMessageBytes: this.maxMessageBytes },
          );
        }

        // 7. Update changed flags
        if (changes.flagChanged.length > 0) {
          await updateFlags(this.db, folderId, changes.flagChanged);
          result.updatedFlags = changes.flagChanged.length;
        }

        // 8. Mark removed messages as expunged
        if (changes.deletedUids.length > 0) {
          await expungeMessages(this.db, folderId, changes.deletedUids);
          result.deletedMessages = changes.deletedUids.length;
        }

        // 9. Update folder state
        await this.updateFolderState(folderId, mailbox);
      } finally {
        releaseLock();
      }

      log.info(
        {
          folderId,
          folderImapName,
          newMessages: result.newMessages,
          updatedFlags: result.updatedFlags,
          deletedMessages: result.deletedMessages,
        },
        "Folder sync complete",
      );
    } catch (err) {
      if (err instanceof SyncAbortedError) {
        // Shutdown in progress, not a sync failure -- propagate so the caller's folder
        // loop stops instead of moving on to the next folder.
        throw err;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      // A connection-level error will fail identically for every remaining folder in
      // this cycle; the caller checks this flag to abort rather than keep looping.
      const connectionLost = !this.client.isConnected();
      result.errors.push(errMsg);
      result.connectionLost = connectionLost;
      log.error({ err, folderId, folderImapName, connectionLost }, "Folder sync failed");

      if (connectionLost) {
        return result;
      }

      // Update folder error state (folder-scoped only -- a dead connection isn't this
      // folder's problem, and every other folder would race to write the same message).
      await this.db
        .updateTable("folders")
        .set({ sync_error: errMsg })
        .where("id", "=", folderId)
        .execute()
        .catch((dbErr) => {
          log.error({ err: dbErr }, "Failed to update folder sync_error");
        });
    }

    return result;
  }

  /**
   * Full resync: fetch ALL messages for a folder.
   * Used on first sync (backfill=true) or when UIDVALIDITY changes (backfill=false --
   * the folder already had its initial sync, this is a resync, not backfill).
   *
   * When backfill=true, per-message postimap_events are suppressed for the duration and
   * a single folder sync_complete event fires once the folder is fully synced.
   */
  async fullSync(
    folderId: string,
    folderImapName: string,
    backfill = false,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const result: SyncResult = { ...EMPTY_RESULT, errors: [] };

    try {
      throwIfAborted(signal);

      const lock = await this.client.getMailboxLock(folderImapName);

      try {
        const mailbox = this.client.client.mailbox;
        if (!mailbox) {
          result.errors.push("Failed to open mailbox");
          return result;
        }

        // Search all UIDs
        const allUids = await this.client.client.search({ all: true }, { uid: true });
        if (allUids === false || allUids.length === 0) {
          log.info({ folderId, folderImapName }, "Folder is empty");
          await this.updateFolderState(folderId, mailbox);
        } else {
          // Fetch all messages. If cancelled partway through, fetchAndStoreMessages
          // throws SyncAbortedError -- everything below (expunge diff, folder state,
          // initial_sync_done) is then correctly skipped: the folder is left exactly as
          // "not fully synced yet", which is what it is, and the next sync picks up
          // where this one left off rather than being told the folder is caught up.
          result.newMessages = await fetchAndStoreMessages(
            this.client.client,
            this.db,
            this.accountId,
            folderId,
            allUids,
            { backfill, signal, maxMessageBytes: this.maxMessageBytes },
          );

          // Mark any messages in PG that are not on the server as expunged
          const existingUids = await this.getKnownUids(folderId);
          const remoteUidSet = new Set(allUids);
          const toExpunge = [...existingUids].filter((uid) => !remoteUidSet.has(uid));
          if (toExpunge.length > 0) {
            await expungeMessages(this.db, folderId, toExpunge);
            result.deletedMessages = toExpunge.length;
          }

          // Update folder state
          await this.updateFolderState(folderId, mailbox);
        }
      } finally {
        lock.release();
      }

      if (backfill) {
        await withSyncWriter(this.db, (trx) =>
          trx
            .updateTable("folders")
            .set({ initial_sync_done: true })
            .where("id", "=", folderId)
            .execute(),
        );
      }

      log.info(
        {
          folderId,
          folderImapName,
          newMessages: result.newMessages,
          deletedMessages: result.deletedMessages,
        },
        "Full sync complete",
      );
    } catch (err) {
      if (err instanceof SyncAbortedError) {
        log.info({ folderId, folderImapName }, "Full sync aborted (shutdown)");
        throw err;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      const connectionLost = !this.client.isConnected();
      result.errors.push(errMsg);
      result.connectionLost = connectionLost;
      log.error({ err, folderId, folderImapName, connectionLost }, "Full sync failed");
    }

    return result;
  }

  /** Build FolderState from PG for change detection */
  private async getFolderState(folderId: string): Promise<FolderState> {
    const folder = await this.db
      .selectFrom("folders")
      .select(["id", "uidvalidity", "highestmodseq", "uidnext"])
      .where("id", "=", folderId)
      .executeTakeFirstOrThrow();

    const messages = await this.db
      .selectFrom("messages")
      .select([
        "imap_uid",
        "is_seen",
        "is_flagged",
        "is_answered",
        "is_draft",
        "is_deleted",
        "keywords",
      ])
      .where("folder_id", "=", folderId)
      .where("expunged_at", "is", null)
      // A pending optimistic move has no imap_uid yet -- it isn't authoritative IMAP
      // state until PostIMAP completes the move and writes the real UID back.
      .where("imap_uid", "is not", null)
      .execute();

    const knownUids = new Set<number>();
    const knownFlags = new Map<number, Set<string>>();

    for (const msg of messages) {
      const uid = Number(msg.imap_uid);
      knownUids.add(uid);

      const flags = new Set<string>();
      if (msg.is_seen) flags.add("\\Seen");
      if (msg.is_flagged) flags.add("\\Flagged");
      if (msg.is_answered) flags.add("\\Answered");
      if (msg.is_draft) flags.add("\\Draft");
      if (msg.is_deleted) flags.add("\\Deleted");
      for (const kw of msg.keywords ?? []) {
        flags.add(kw);
      }
      knownFlags.set(uid, flags);
    }

    return {
      folderId,
      uidvalidity: folder.uidvalidity ? BigInt(folder.uidvalidity) : null,
      highestmodseq: folder.highestmodseq ? BigInt(folder.highestmodseq) : null,
      uidnext: folder.uidnext ? BigInt(folder.uidnext) : null,
      knownUids,
      knownFlags,
    };
  }

  /**
   * Forces a genuine QRESYNC-parameterized SELECT of an already-locked folder, collecting
   * the VANISHED and changed-FETCH responses the server sends inline as a result.
   *
   * getMailboxLock() has its own fast path that skips SELECT entirely when the folder is
   * already open on this connection (e.g. cycling back to a folder visited last cycle),
   * so it cannot be relied on to request QRESYNC's delta -- this issues a second, explicit
   * SELECT while still holding the lock, which always runs for real.
   *
   * ImapFlow's public MailboxOpenOptions type doesn't declare `changedSince`/`uidValidity`,
   * but the underlying SELECT command reads them directly (imapflow/lib/commands/select.js)
   * -- this is what actually requests the server's QRESYNC delta instead of a plain SELECT.
   */
  private async reselectForQresync(
    folderImapName: string,
    folderState: FolderState,
  ): Promise<{ mailbox: MailboxObject; events: QresyncSelectEvents }> {
    const client = this.client.client;
    const vanishedUids: number[] = [];
    const flagUpdates: FlagChange[] = [];

    const onExpunge = (evt: ExpungeEvent): void => {
      if (evt.vanished && evt.uid !== undefined) vanishedUids.push(evt.uid);
    };
    const onFlags = (evt: FlagsEvent): void => {
      if (evt.uid !== undefined) {
        flagUpdates.push({ uid: evt.uid, flags: evt.flags, modseq: evt.modseq });
      }
    };

    client.on("expunge", onExpunge);
    client.on("flags", onFlags);

    let mailbox: MailboxObject;
    try {
      const options: QresyncSelectOptions = {
        changedSince: folderState.highestmodseq?.toString(),
        uidValidity: folderState.uidvalidity ?? undefined,
      };
      mailbox = await client.mailboxOpen(folderImapName, options);
    } finally {
      client.off("expunge", onExpunge);
      client.off("flags", onFlags);
    }

    return { mailbox, events: { vanishedUids, flagUpdates } };
  }

  /** Get set of known UIDs for a folder (live messages with a confirmed IMAP UID) */
  private async getKnownUids(folderId: string): Promise<Set<number>> {
    const rows = await this.db
      .selectFrom("messages")
      .select("imap_uid")
      .where("folder_id", "=", folderId)
      .where("expunged_at", "is", null)
      .where("imap_uid", "is not", null)
      .execute();

    return new Set(rows.map((r) => Number(r.imap_uid)));
  }

  /** Update folder metadata after sync */
  private async updateFolderState(
    folderId: string,
    mailbox: import("imapflow").MailboxObject,
  ): Promise<void> {
    await this.db
      .updateTable("folders")
      .set({
        uidvalidity: String(mailbox.uidValidity),
        uidnext: String(mailbox.uidNext),
        highestmodseq: mailbox.highestModseq ? String(mailbox.highestModseq) : null,
        last_synced_at: new Date(),
        sync_error: null,
      })
      .where("id", "=", folderId)
      .execute();
  }
}
