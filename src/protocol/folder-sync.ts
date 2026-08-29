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

/** Discover all folders from the IMAP server */
export async function discoverFolders(client: ImapFlow): Promise<FolderInfo[]> {
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
