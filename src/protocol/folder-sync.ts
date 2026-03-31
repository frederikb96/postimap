import type { ImapFlow, ListResponse } from "imapflow";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
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
        log.warn({ folder: folder.imapName, err }, "Failed to read mailboxId");
      }
    }
  }

  return folders;
}

export interface FolderSyncResult {
  created: string[];
  deleted: string[];
  renamed: string[];
}

/** Sync remote folder list to the folders table in PG */
export async function syncFoldersToPg(
  db: Kysely<Database>,
  accountId: string,
  remoteFolders: FolderInfo[],
  capabilities: ServerCapabilities,
): Promise<FolderSyncResult> {
  const result: FolderSyncResult = { created: [], deleted: [], renamed: [] };

  const existingRows = await db
    .selectFrom("folders")
    .selectAll()
    .where("account_id", "=", accountId)
    .execute();

  const existingByName = new Map(existingRows.map((r) => [r.imap_name, r]));
  const existingByMailboxId = new Map(
    existingRows
      .filter((r): r is typeof r & { mailbox_id: string } => r.mailbox_id != null)
      .map((r) => [r.mailbox_id, r]),
  );
  const remoteNames = new Set(remoteFolders.map((f) => f.imapName));

  for (const remote of remoteFolders) {
    const existing = existingByName.get(remote.imapName);

    if (existing) {
      // Folder exists with same name -- update metadata if needed
      await db
        .updateTable("folders")
        .set({
          separator: remote.separator,
          special_use: remote.specialUse ?? null,
          mailbox_id: remote.mailboxId ?? existing.mailbox_id,
        })
        .where("id", "=", existing.id)
        .execute();
      continue;
    }

    // Check for rename: same MAILBOXID but different imap_name
    if (capabilities.mailboxId && remote.mailboxId) {
      const renamedFrom = existingByMailboxId.get(remote.mailboxId);
      if (renamedFrom && !remoteNames.has(renamedFrom.imap_name)) {
        log.info(
          { from: renamedFrom.imap_name, to: remote.imapName },
          "Folder rename detected via MAILBOXID",
        );
        await db
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
    await db
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

  // Mark folders that no longer exist on the server as deleted
  for (const existing of existingRows) {
    if (!remoteNames.has(existing.imap_name)) {
      await db.deleteFrom("folders").where("id", "=", existing.id).execute();
      result.deleted.push(existing.imap_name);
      log.info({ folder: existing.imap_name }, "Folder deleted (no longer on server)");
    }
  }

  return result;
}
