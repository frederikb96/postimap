import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { selectSyncTier } from "../imap/capabilities.js";
import type { ImapClient } from "../imap/pool.js";
import { expungeMessages, fetchAndStoreMessages, updateFlags } from "../protocol/message-sync.js";
import { createLogger } from "../util/logger.js";
import { detectChanges, type FolderState } from "./change-detector.js";
import { getPendingOutboundUids } from "./loop-guard.js";

const log = createLogger("inbound-sync");

export interface SyncResult {
  newMessages: number;
  updatedFlags: number;
  deletedMessages: number;
  errors: string[];
}

const EMPTY_RESULT: SyncResult = {
  newMessages: 0,
  updatedFlags: 0,
  deletedMessages: 0,
  errors: [],
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
  ) {}

  /**
   * Incremental sync for a single folder.
   * Uses three-tier change detection to identify what changed since last sync.
   */
  async syncFolder(folderId: string, folderImapName: string): Promise<SyncResult> {
    const result: SyncResult = { ...EMPTY_RESULT, errors: [] };

    try {
      // 1. Get folder state from PG
      const folderState = await this.getFolderState(folderId);

      // 2. Get pending outbound UIDs (loop guard)
      const pendingUids = await getPendingOutboundUids(this.db, this.accountId, folderId);

      // 3. Select folder on IMAP via mailbox lock
      const lock = await this.client.getMailboxLock(folderImapName);

      try {
        const mailbox = this.client.client.mailbox;
        if (!mailbox) {
          result.errors.push("Failed to open mailbox");
          return result;
        }

        // 4. Check UIDVALIDITY
        if (folderState.uidvalidity !== null && mailbox.uidValidity !== folderState.uidvalidity) {
          log.warn({ folderId, folderImapName }, "UIDVALIDITY changed, performing full resync");
          lock.release();
          return this.fullSync(folderId, folderImapName);
        }

        // 5. Detect changes (three-tier)
        const tier = selectSyncTier(this.capabilities);
        const changes = await detectChanges(this.client.client, folderState, tier, pendingUids);

        if (changes.uidValidityChanged) {
          lock.release();
          return this.fullSync(folderId, folderImapName);
        }

        // 6. Fetch new messages (batched)
        if (changes.newUids.length > 0) {
          result.newMessages = await fetchAndStoreMessages(
            this.client.client,
            this.db,
            this.accountId,
            folderId,
            changes.newUids,
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
        lock.release();
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
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(errMsg);
      log.error({ err, folderId, folderImapName }, "Folder sync failed");

      // Update folder error state
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
  async fullSync(folderId: string, folderImapName: string, backfill = false): Promise<SyncResult> {
    const result: SyncResult = { ...EMPTY_RESULT, errors: [] };

    try {
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
          // Fetch all messages
          result.newMessages = await fetchAndStoreMessages(
            this.client.client,
            this.db,
            this.accountId,
            folderId,
            allUids,
            { backfill },
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
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(errMsg);
      log.error({ err, folderId, folderImapName }, "Full sync failed");
    }

    return result;
  }

  /** Build FolderState from PG for change detection */
  private async getFolderState(folderId: string): Promise<FolderState> {
    const folder = await this.db
      .selectFrom("folders")
      .select(["id", "uidvalidity", "highestmodseq"])
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
      knownUids,
      knownFlags,
    };
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
