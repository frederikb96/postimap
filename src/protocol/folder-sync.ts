import type { ImapFlow, ListResponse } from "imapflow";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("folder-sync");

export interface FolderInfo {
  imapName: string;
  separator: string;
  specialUse?: string;
  mailboxId?: string;
}

/** SPECIAL-USE flags recognized by IMAP (RFC 6154) mapped to lowercase DB values */
const SPECIAL_USE_MAP: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Flagged": "flagged",
};

function normalizeSpecialUse(raw?: string): string | undefined {
  if (!raw) return undefined;
  return SPECIAL_USE_MAP[raw];
}

/**
 * Discover all folders from the IMAP server.
 *
 * `resolvedNames` names folders whose MAILBOXID is already stored, so nothing has to be
 * opened to learn it again. Passing the set turns a repeated discovery into a single
 * LIST: the per-folder open below then runs only for names that are new to PG or whose
 * earlier lookup produced nothing, which are the only ones rename detection can use.
 */
export async function discoverFolders(
  client: ImapFlow,
  resolvedNames?: ReadonlySet<string>,
): Promise<FolderInfo[]> {
  const listed: ListResponse[] = await client.list();
  const folders: FolderInfo[] = [];

  for (const entry of listed) {
    folders.push({
      imapName: entry.path,
      separator: entry.delimiter,
      specialUse: normalizeSpecialUse(entry.specialUse),
      mailboxId: undefined, // populated below via STATUS if supported
    });
  }

  // ImapFlow's list() doesn't return MAILBOXID; fetch via STATUS OBJECTID per folder if supported
  if (client.capabilities.has("OBJECTID")) {
    for (const folder of folders) {
      if (resolvedNames?.has(folder.imapName)) continue;
      try {
        const mb = await client.mailboxOpen(folder.imapName, { readOnly: true });
        if (mb.mailboxId) {
          folder.mailboxId = mb.mailboxId;
        }
        await client.mailboxClose();
      } catch (err) {
        // A single folder's OBJECTID lookup failing (e.g. an ACL issue) is tolerable --
        // the folder is still usable, it just won't get rename detection. A dead
        // connection is not: without this check every remaining folder would repeat the
        // same "not connected" failure in a tight loop instead of aborting the account.
        if (!client.usable) {
          throw err;
        }
        log.warn({ folder: folder.imapName, err }, "Failed to read mailboxId");
      }
    }
  }

  return folders;
}

/**
 * Folder ids whose create or delete has been enqueued and not yet applied to the server.
 *
 * These are the folders where PG and the server are *meant* to disagree for a moment, and
 * reconciling them during that window undoes the consumer's request: a folder just created
 * is absent from LIST and would be tombstoned, and a folder just tombstoned is still in
 * LIST and would be un-tombstoned. Both look exactly like a folder appearing or vanishing
 * on the server, which is why the queue -- not the folder list -- is what tells them apart.
 *
 * A dead-lettered entry is deliberately not counted. Once the request can no longer
 * succeed, the folder's absence from LIST is the truth again and reconciliation should act
 * on it, which is what makes a permanently-failed create converge instead of dangling.
 */
async function getPendingFolderOps(db: Kysely<Database>, accountId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom("sync_queue")
    .select("folder_id")
    .where("account_id", "=", accountId)
    .where("action", "in", ["folder_create", "folder_delete"])
    .where("status", "in", ["pending", "processing", "failed"])
    .where("folder_id", "is not", null)
    .execute();

  return new Set(rows.map((r) => r.folder_id as string));
}

export interface FolderSyncResult {
  created: string[];
  undeleted: string[];
  softDeleted: string[];
  renamed: string[];
}

/**
 * Sync remote folder list to the folders table in PG.
 *
 * A folder absent from the LIST response is soft-deleted (deleted_at set), never
 * hard-deleted -- a flaky or partial LIST response must not cascade away a folder's
 * mirrored messages and attachments. If it reappears, deleted_at is cleared.
 */
export async function syncFoldersToPg(
  db: Kysely<Database>,
  accountId: string,
  remoteFolders: FolderInfo[],
  capabilities: ServerCapabilities,
): Promise<FolderSyncResult> {
  const result: FolderSyncResult = { created: [], undeleted: [], softDeleted: [], renamed: [] };

  // Folders the consumer has asked to create or delete, whose request has not reached the
  // server yet. Reconciling those against LIST would undo the request.
  const pendingOps = await getPendingFolderOps(db, accountId);

  const existingRows = await db
    .selectFrom("folders")
    .selectAll()
    .where("account_id", "=", accountId)
    .execute();

  const hasLiveFolders = existingRows.some((r) => r.deleted_at === null);
  if (remoteFolders.length === 0 && hasLiveFolders) {
    // A LIST that comes back empty for an account known to have folders is far more
    // likely a flaky or partial response than a mailbox that was actually emptied out --
    // treat it as a sync error, never as license to soft-delete every folder at once.
    throw new Error(
      `LIST returned zero folders for account ${accountId}, which has existing folders -- refusing to soft-delete all of them`,
    );
  }

  const liveByName = new Map(
    existingRows.filter((r) => r.deleted_at === null).map((r) => [r.imap_name, r]),
  );
  const deletedByName = new Map(
    existingRows.filter((r) => r.deleted_at !== null).map((r) => [r.imap_name, r]),
  );
  const liveByMailboxId = new Map(
    existingRows
      .filter(
        (r): r is typeof r & { mailbox_id: string } =>
          r.deleted_at === null && r.mailbox_id != null,
      )
      .map((r) => [r.mailbox_id, r]),
  );
  const remoteNames = new Set(remoteFolders.map((f) => f.imapName));

  await withSyncWriter(db, async (trx) => {
    for (const remote of remoteFolders) {
      const live = liveByName.get(remote.imapName);

      if (live) {
        // Folder exists with same name -- update metadata if needed
        await trx
          .updateTable("folders")
          .set({
            separator: remote.separator,
            special_use: remote.specialUse ?? null,
            mailbox_id: remote.mailboxId ?? live.mailbox_id,
          })
          .where("id", "=", live.id)
          .execute();
        continue;
      }

      const tombstoned = deletedByName.get(remote.imapName);
      if (tombstoned && pendingOps.has(tombstoned.id)) {
        // The consumer tombstoned this folder and the DELETE has not run yet, so the
        // server still lists it. Clearing deleted_at here would cancel the request.
        continue;
      }
      if (tombstoned) {
        // Same name reappeared -- undelete rather than insert a duplicate.
        await trx
          .updateTable("folders")
          .set({
            deleted_at: null,
            separator: remote.separator,
            special_use: remote.specialUse ?? null,
            mailbox_id: remote.mailboxId ?? tombstoned.mailbox_id,
          })
          .where("id", "=", tombstoned.id)
          .execute();
        result.undeleted.push(remote.imapName);
        log.info({ folder: remote.imapName }, "Folder reappeared, cleared soft-delete");
        continue;
      }

      // Check for rename: same MAILBOXID but different imap_name
      if (capabilities.mailboxId && remote.mailboxId) {
        const renamedFrom = liveByMailboxId.get(remote.mailboxId);
        if (renamedFrom && !remoteNames.has(renamedFrom.imap_name)) {
          log.info(
            { from: renamedFrom.imap_name, to: remote.imapName },
            "Folder rename detected via MAILBOXID",
          );
          await trx
            .updateTable("folders")
            .set({
              imap_name: remote.imapName,
              separator: remote.separator,
              special_use: remote.specialUse ?? null,
            })
            .where("id", "=", renamedFrom.id)
            .execute();
          result.renamed.push(`${renamedFrom.imap_name} -> ${remote.imapName}`);
          continue;
        }
      }

      // New folder
      await trx
        .insertInto("folders")
        .values({
          account_id: accountId,
          imap_name: remote.imapName,
          separator: remote.separator,
          special_use: remote.specialUse ?? null,
          mailbox_id: remote.mailboxId ?? null,
        })
        .execute();
      result.created.push(remote.imapName);
      log.info({ folder: remote.imapName }, "New folder created");
    }

    // Soft-delete folders that are live in PG but no longer on the server
    for (const existing of existingRows) {
      if (existing.deleted_at === null && pendingOps.has(existing.id)) {
        // Created by the consumer, not on the server yet. Absent from LIST is the
        // expected state until the queue drains, not evidence the folder went away.
        continue;
      }
      if (existing.deleted_at === null && !remoteNames.has(existing.imap_name)) {
        await trx
          .updateTable("folders")
          .set({ deleted_at: new Date() })
          .where("id", "=", existing.id)
          .execute();
        result.softDeleted.push(existing.imap_name);
        log.info({ folder: existing.imap_name }, "Folder soft-deleted (no longer on server)");
      }
    }
  });

  return result;
}
