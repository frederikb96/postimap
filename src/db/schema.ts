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
  /**
   * The server's LSUB/LIST-EXTENDED answer. A server that tracks no subscription state
   * reports every mailbox as subscribed, so true means "visible", never "the user picked
   * this one".
   */
  subscribed: Generated<boolean>;
  /** Whether a consumer wants IMAP push for this folder. Consumer-writable. */
  idle_requested: Generated<boolean>;
  /**
   * PostIMAP's answer: 'off' | 'watching' | 'unsupported' | 'failed'. NULL means the folder
   * has not been considered yet, which is what lets `sync.idle_folders` seed a preference
   * exactly once.
   */
  idle_status: string | null;
  /** Set when the folder is absent from the latest IMAP LIST; cleared if it reappears. */
  deleted_at: Date | null;
  /** Flips true once this folder's initial full sync completes; gates backfill suppression. */
  initial_sync_done: Generated<boolean>;
  /**
   * How many messages the server held when this folder's backfill started -- the
   * denominator for `total_count`. NULL until the backfill begins.
   */
  backfill_total: number | null;
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
  /** Set when the message exceeded storage.max_message_bytes: body/attachments were never fetched. */
  is_truncated: Generated<boolean>;
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

/**
 * A write that never reached the server, kept until a consumer acknowledges it.
 *
 * One row per operation that reaches a terminal failure. `message_id`, `folder_id` and
 * `outbox_id` are nullable because retention outlives none of them -- `detail` carries
 * enough identity to render the row after they are gone.
 */
export interface SyncNotificationTable {
  id: Generated<string>;
  account_id: string;
  action: string;
  message_id: string | null;
  folder_id: string | null;
  outbox_id: string | null;
  error: string | null;
  detail: unknown | null;
  /** The only consumer-writable column on this table. */
  acknowledged_at: Date | null;
  /** Set once the folder has been re-read, so the mirror now shows the server's truth. */
  reverted_at: Date | null;
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
  replaces_message_id: string | null;
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

export interface DavAccountTable {
  id: Generated<string>;
  name: string;
  /** The discovery URL, e.g. https://cloud.example.org/remote.php/dav/ */
  url: string;
  username: string;
  password: Buffer;
  is_active: Generated<boolean>;
  state: Generated<string>;
  state_error: string | null;
  principal_url: string | null;
  calendar_home_url: string | null;
  addressbook_home_url: string | null;
  last_polled_at: Date | null;
  error_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DavCollectionTable {
  id: Generated<string>;
  account_id: string;
  kind: string;
  /** Server path. NULL until a consumer-created collection exists on the server. */
  href: string | null;
  /** The last path segment the consumer chose on insert. */
  slug: string;
  display_name: string | null;
  color: string | null;
  description: string | null;
  supported_components: string[] | null;
  read_only: Generated<boolean>;
  sync_tier: string | null;
  sync_token: string | null;
  ctag: string | null;
  initial_sync_done: Generated<boolean>;
  backfill_total: number | null;
  total_count: Generated<number>;
  last_synced_at: Date | null;
  last_full_reconcile_at: Date | null;
  sync_error: string | null;
  deleted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DavObjectTable {
  id: Generated<string>;
  account_id: string;
  collection_id: string;
  /** NULL = created here, not yet on the server. */
  href: string | null;
  /** NULL = local change not yet acknowledged; the imap_uid IS NULL idiom. */
  etag: string | null;
  kind: string;
  /** The verbatim iCalendar/vCard body -- the unit of sync is the whole resource. */
  data: string;
  uid: string | null;
  component: string | null;
  /** vCard FN for a contact. */
  summary: string | null;
  dtstart: Date | null;
  dtend: Date | null;
  dtstart_tz: string | null;
  all_day: Generated<boolean>;
  is_recurring: Generated<boolean>;
  has_exceptions: Generated<boolean>;
  status: string | null;
  sequence: number | null;
  organizer: string | null;
  attendees: unknown | null;
  emails: string[] | null;
  last_modified: Date | null;
  size_bytes: number | null;
  deleted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Internal outbound work queue for DAV writes -- never granted to consumers. */
export interface DavSyncQueueTable {
  id: Generated<string>;
  account_id: string;
  collection_id: string | null;
  object_id: string | null;
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

/**
 * A DAV write that never reached the server, kept until a consumer acknowledges it. Same
 * shape and retention rule as sync_notifications, kept as its own table rather than widened
 * columns on that one -- see docs/consumer-contract.md.
 */
export interface DavNotificationTable {
  id: Generated<string>;
  account_id: string;
  action: string;
  collection_id: string | null;
  object_id: string | null;
  error: string | null;
  detail: unknown | null;
  acknowledged_at: Date | null;
  reverted_at: Date | null;
  created_at: Generated<Date>;
}

export interface Database {
  accounts: AccountTable;
  folders: FolderTable;
  messages: MessageTable;
  attachments: AttachmentTable;
  sync_queue: SyncQueueTable;
  sync_state: SyncStateTable;
  sync_audit: SyncAuditTable;
  sync_notifications: SyncNotificationTable;
  outbox: OutboxTable;
  outbox_attachments: OutboxAttachmentTable;
  postimap_info: PostimapInfoTable;
  dav_accounts: DavAccountTable;
  dav_collections: DavCollectionTable;
  dav_objects: DavObjectTable;
  dav_sync_queue: DavSyncQueueTable;
  dav_notifications: DavNotificationTable;
}
