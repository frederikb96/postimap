import type { ColumnType, Generated } from "kysely";

export interface AccountTable {
  id: Generated<string>;
  name: string;
  imap_host: string;
  imap_port: Generated<number>;
  imap_user: string;
  imap_password: Buffer;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password: Buffer | null;
  is_active: Generated<boolean>;
  state: Generated<string>;
  state_error: string | null;
  capabilities: unknown | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface FolderTable {
  id: Generated<string>;
  account_id: string;
  imap_name: string;
  display_name: string | null;
  separator: string | null;
  mailbox_id: string | null;
  special_use: string | null;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  total_count: Generated<number>;
  unread_count: Generated<number>;
  last_synced_at: Date | null;
  sync_error: string | null;
  /** Set when the folder is absent from the latest IMAP LIST; cleared if it reappears. */
  deleted_at: Date | null;
  /** Flips true once this folder's initial full sync completes; gates backfill suppression. */
  initial_sync_done: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MessageTable {
  id: Generated<string>;
  account_id: string;
  folder_id: string;
  /** NULL while an optimistic app-initiated move is pending PostIMAP's IMAP MOVE. */
  imap_uid: string | null;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  to_addrs: unknown | null;
  cc_addrs: unknown | null;
  bcc_addrs: unknown | null;
  reply_to: string | null;
  in_reply_to: string | null;
  references: string[] | null;
  body_text: string | null;
  body_html: string | null;
  raw_headers: unknown | null;
  raw_source: Buffer | null;
  received_at: Date | null;
  size_bytes: number | null;
  modseq: string | null;
  is_seen: Generated<boolean>;
  is_flagged: Generated<boolean>;
  is_answered: Generated<boolean>;
  is_draft: Generated<boolean>;
  is_deleted: Generated<boolean>;
  keywords: Generated<string[]>;
  /** Set when the message is gone from the IMAP server (distinct from the \Deleted flag). */
  expunged_at: Date | null;
  /** Resolved via references/in_reply_to on insert; see resolveThreadId in threading.ts. */
  thread_id: Generated<string>;
  search_vector: ColumnType<string, never, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AttachmentTable {
  id: Generated<string>;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  content_id: string | null;
  size_bytes: number | null;
  data: Buffer | null;
}

export interface SyncQueueTable {
  id: Generated<string>;
  account_id: string;
  message_id: string | null;
  folder_id: string | null;
  action: string;
  payload: Generated<unknown>;
  status: Generated<string>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  error: string | null;
  created_at: Generated<Date>;
  processed_at: Date | null;
  next_retry_at: Generated<Date>;
}

export interface SyncStateTable {
  account_id: string;
  last_full_sync: Date | null;
  last_incr_sync: Date | null;
  sync_tier: string | null;
  folders_synced: Generated<number>;
  folders_total: Generated<number>;
  messages_synced: Generated<string>;
  error_count: Generated<number>;
  last_error: string | null;
  updated_at: Generated<Date>;
}

export interface SyncAuditTable {
  id: Generated<string>;
  account_id: string;
  direction: string;
  action: string;
  message_id: string | null;
  folder_id: string | null;
  detail: unknown | null;
  created_at: Generated<Date>;
}

export interface OutboxTable {
  id: Generated<string>;
  account_id: string;
  kind: string;
  from_addr: string | null;
  to_addrs: unknown | null;
  cc_addrs: unknown | null;
  bcc_addrs: unknown | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  references: string[] | null;
  status: Generated<string>;
  error: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  sent_message_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  sent_at: Date | null;
  next_retry_at: Generated<Date>;
}

export interface OutboxAttachmentTable {
  id: Generated<string>;
  outbox_id: string;
  filename: string | null;
  content_type: string | null;
  data: Buffer | null;
}

export interface PostimapInfoTable {
  singleton: Generated<boolean>;
  contract_version: number;
  service_version: Generated<string>;
  updated_at: Generated<Date>;
}

export interface Database {
  accounts: AccountTable;
  folders: FolderTable;
  messages: MessageTable;
  attachments: AttachmentTable;
  sync_queue: SyncQueueTable;
  sync_state: SyncStateTable;
  sync_audit: SyncAuditTable;
  outbox: OutboxTable;
  outbox_attachments: OutboxAttachmentTable;
  postimap_info: PostimapInfoTable;
}
