import { randomUUID } from "node:crypto";
import { Factory } from "fishery";
import type { FolderTable } from "../../src/db/schema.js";

type FolderBuild = {
  [K in keyof FolderTable]: FolderTable[K] extends import("kysely").Generated<infer U>
    ? U
    : FolderTable[K];
};

export const folderFactory = Factory.define<FolderBuild>(({ sequence, associations }) => ({
  id: randomUUID(),
  account_id: (associations as { account_id?: string }).account_id ?? randomUUID(),
  imap_name: `INBOX.folder-${sequence}`,
  display_name: `Folder ${sequence}`,
  separator: "/",
  mailbox_id: null,
  special_use: null,
  uidvalidity: "1",
  uidnext: "1",
  highestmodseq: "1",
  exists_count: 0,
  total_count: 0,
  unread_count: 0,
  last_synced_at: null,
  sync_error: null,
  created_at: new Date(),
}));

export const inboxFactory = folderFactory.params({
  imap_name: "INBOX",
  display_name: "Inbox",
  special_use: "inbox",
});

export const sentFactory = folderFactory.params({
  imap_name: "Sent",
  display_name: "Sent",
  special_use: "sent",
});

export const draftsFactory = folderFactory.params({
  imap_name: "Drafts",
  display_name: "Drafts",
  special_use: "drafts",
});

export const trashFactory = folderFactory.params({
  imap_name: "Trash",
  display_name: "Trash",
  special_use: "trash",
});

export const archiveFactory = folderFactory.params({
  imap_name: "Archive",
  display_name: "Archive",
  special_use: "archive",
});
