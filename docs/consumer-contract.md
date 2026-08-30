# Consumer contract

PostgreSQL is PostIMAP's only interface. There is no REST API, no SDK, no client library.
A consumer reads and writes the tables below with plain SQL, and listens for change
notifications with `LISTEN`/`NOTIFY`. This document is the contract: which tables exist,
exactly which columns a consumer may write, the shape of every NOTIFY payload, and worked
examples for the common operations.

The contract is versioned. See [Versioning](#versioning) for how to check compatibility
before relying on any of this.

## Versioning

```sql
SELECT contract_version, service_version FROM postimap_info;
```

`postimap_info` is a single-row table. `contract_version` is an integer, bumped whenever
this document's guarantees change in a breaking way; `service_version` mirrors the running
image's `package.json` version, for diagnostics. A consumer should assert
`contract_version` at startup and refuse to run against a version it wasn't built for.

## The write contract is enforced by the database

Migrations create a `NOLOGIN` role, `postimap_app`, and grant it exactly the columns
listed in this document -- nothing more. A production deployment grants `postimap_app` to
the consumer's own login role:

```sql
GRANT postimap_app TO your_app_role;
```

Writing outside the granted columns fails with `permission denied`, not silently. This is
the actual mechanism, not a convention documented here and hoped for -- the grant list
below is authoritative because it's what PostgreSQL checks.

## Tables

### `accounts`

IMAP/SMTP credentials and connection state for one mailbox.

| column | writable | notes |
|---|---|---|
| `id` | read-only | UUID, generated |
| `name` | insert, update | unique display name |
| `imap_host`, `imap_port`, `imap_user` | insert | |
| `imap_password` | insert, update | see [Credentials](#credentials) |
| `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password` | insert, update | optional; required for outbox send |
| `is_active` | insert, update | set `false` to pause sync without deleting the account |
| `state` | read-only | `created` \| `syncing` \| `active` \| `error` \| `disabled`, PostIMAP-managed. `error` is not terminal -- see below |
| `state_error` | read-only | last error message when `state = 'error'` |
| `capabilities` | read-only | detected server capabilities, jsonb |
| `created_at` | read-only | |
| `updated_at` | read-only | maintained automatically on every update |

Inserting a row is how you add an account. PostIMAP detects it via `postimap_events`
(`type: "account", op: "insert"`) and starts syncing without a restart.

**`error` is a retrying state, not a dead one.** A failure at any point -- including the
very first connection, so a mail host that is briefly unresolvable while a deployment comes
up counts -- puts the account in `error` and schedules a retry. Retries are unbounded and
back off exponentially up to a cap (`src/sync/account-sync.ts`), and each one re-resolves
the host, so an account recovers on its own once the cause clears; a transient failure can
still sit in `error` for the length of the current backoff before it does. Watch
`sync_state.error_count` climbing to tell a retrying account from a stuck one, and treat
`error` as "not usable right now" rather than as something needing intervention. Only
`disabled` means PostIMAP has stopped trying.

`sync_state.last_full_sync` separates the two failures worth telling a user apart: it stays
NULL until an account's first full sync completes, so `state = 'error'` with a NULL
`last_full_sync` is an account that has never once connected -- wrong host, wrong
credentials, something the user has to fix -- while a non-NULL one is an account that
worked and is now having a bad time, which usually fixes itself.

**Deleting an account** is a plain `DELETE` -- `accounts` is the one table a consumer may
delete from, and it is enough, because every table hanging off it (`folders`, `messages`,
`attachments`, `sync_queue`, `sync_state`, `sync_audit`, `outbox`) declares
`ON DELETE CASCADE`:

```sql
DELETE FROM accounts WHERE id = $1;
```

This is irreversible and takes the entire mirrored mailbox with it. Nothing is removed
from the IMAP server -- the mailbox stays exactly as it is and re-adding the account
re-syncs it. To stop syncing while keeping the data, set `is_active = false` instead.
PostIMAP sees the delete on `postimap_events` and shuts that account's sync down; an
in-flight sync at that moment fails harmlessly against the already-removed rows.

Available from service version `1.0.1` (`postimap_info.service_version`); the contract
version is unchanged, since granting a new permission breaks nothing a consumer already
does.

### `folders`

The IMAP folder list for an account, one row per mailbox.

| column | writable | notes |
|---|---|---|
| `imap_name` | insert | set once, when creating a folder -- see [Creating a folder](#creating-a-folder). Not updatable: renaming is not available, see below |
| `account_id` | insert | which account the folder belongs to |
| `display_name` | insert, update | a label for your own UI. PostIMAP never sends it to the server |
| `separator`, `mailbox_id`, `special_use` | read-only | |
| `subscribed` | read-only | whether the user has subscribed to this folder on the server -- see below |
| `idle_requested` | update | ask for IMAP push on this folder -- see below |
| `idle_status` | read-only | what became of that request: `off`, `watching`, `unsupported` or `failed` |
| `uidvalidity`, `uidnext`, `highestmodseq` | read-only | IMAP sync bookkeeping |
| `total_count`, `unread_count` | read-only | maintained by trigger on every message change |
| `last_synced_at`, `sync_error` | read-only | |
| `deleted_at` | update | set it to delete the folder on the server -- see [Deleting a folder](#deleting-a-folder). PostIMAP also sets it itself when a folder is absent from the server's LIST, and clears it if the folder reappears |
| `initial_sync_done` | read-only | flips true once the folder's first full sync completes -- see [Backfill suppression](#backfill-suppression) |

The list is reconciled from the server's `LIST` on every sync cycle, so a folder created or
removed in another mail client appears or is tombstoned without restarting anything.

**`subscribed` is not a preference you can set.** IMAP separates folders that *exist* from
folders the user has chosen to see, and mail clients show the subscribed ones -- it is how
an account with forty labels does not drown a sidebar. PostIMAP mirrors that state on every
reconciliation cycle; there is no write grant, because changing it would need a UI control
that does not exist yet.

🚨 **A server that tracks no subscription state reports every mailbox as subscribed.** Older
servers answer neither `LSUB` nor `LIST-EXTENDED`, and the correct reading of silence is
"everything is visible", not "the user subscribed to all forty". So `subscribed = true`
means *visible*, never *chosen*, and a UI that hides unsubscribed folders correctly shows
all of them against such a server. `INBOX` is always reported subscribed.

**Asking for push on a folder costs a whole connection, so choose deliberately.** IMAP
IDLE occupies an entire connection -- one parked in IDLE can do nothing else -- and
providers cap concurrent connections per account, commonly around fifteen, counting the
ordinary sync connection and the user's own phone and webmail. Set `idle_requested = true`
on the folders that genuinely need near-real-time updates; everything else still syncs on
the interval.

`idle_status` is PostIMAP's answer, and it is written on every sync cycle:

- `off` -- nothing asked for
- `watching` -- a connection is open and pushing
- `unsupported` -- the server does not offer IDLE
- `failed` -- the watch was requested and is not running. A watch that reconnects with
  backoff and finally gives up lands here, and also writes a `sync_notifications` row, so a
  folder silently ceasing to be real-time is something you find out about

The default set comes from `sync.idle_folders` in the service's own configuration, and it
seeds `idle_requested` **once** -- on the first cycle that considers a folder. After that
the column is the answer, so switching every folder off stays switched off rather than
being read as "expressed no preference".

**Renaming a folder is not available.** IMAP `RENAME` also renames every child folder, so
one command changes the `imap_name` of an unbounded number of other rows -- there is no
way to express that as a single-row `UPDATE`, and `imap_name` therefore carries no `UPDATE`
grant. A rename reaches PG only by being made on the server, where PostIMAP mirrors it.

There is no `DELETE` on `folders` either: setting `deleted_at` is the removal, and the row
survives until retention clears it.

### `messages`

The mirrored message. Full envelope, parsed body, and flags.

| column | writable | notes |
|---|---|---|
| `id` | read-only | UUID |
| `account_id`, `folder_id` | read-only\* | `folder_id` is writable -- see [Moving a message](#moving-a-message) |
| `imap_uid` | writable\* | nullable; NULL means an optimistic move is pending -- see below |
| `message_id`, `subject`, `from_addr`, `to_addrs`, `cc_addrs`, `bcc_addrs`, `reply_to`, `in_reply_to`, `references` | read-only | native jsonb/array, not double-encoded strings. `message_id`, `in_reply_to` and `references` keep the RFC 5322 angle brackets (`<id@host>`) -- matching on a bare `id@host` finds nothing, and does it as a zero-row result rather than an error |
| `body_text`, `body_html`, `raw_headers`, `raw_source` | read-only | `raw_source` is the full RFC822 bytea; NULL when `is_truncated` |
| `received_at`, `size_bytes`, `modseq` | read-only | |
| `is_truncated` | read-only | `true` when the message exceeded `storage.max_message_bytes` at fetch time -- `body_text`/`body_html`/`raw_headers`/`raw_source` and any attachments were never fetched from IMAP and stay NULL/empty; `subject`/`from_addr`/`to_addrs`/etc. are still populated from the envelope |
| `is_seen`, `is_flagged`, `is_answered` | update | maps to `\Seen`, `\Flagged`, `\Answered` |
| `is_draft`, `is_deleted` | update | maps to `\Draft` and `\Deleted`. Setting `is_deleted` marks the message for deletion without removing it; use `expunged_at` to actually remove it |
| `keywords` | update | custom IMAP keywords/labels, `text[]` |
| `expunged_at` | update | set to soft-delete (see [Deleting a message](#deleting-a-message)); distinct from the `\Deleted` flag, which just marks the message for deletion without removing it |
| `search_vector` | read-only | generated column, `to_tsvector('simple', ...)` over subject/from/body -- see [Search](#search) |
| `thread_id` | read-only | groups a conversation -- see [Threading](#threading) |
| `created_at`, `updated_at` | read-only | `updated_at` changes on any write, PostIMAP's or the app's |

\* `folder_id` and `imap_uid` are writable together as the move operation; see below.
Everything else in this table is written exclusively by PostIMAP's sync engine.

There is no `INSERT` on `messages`: a row exists because it exists on the IMAP server, and
the way to create one is to `INSERT` into [`outbox`](#outbox). An `INSERT INTO messages`
fails with `permission denied`.

#### `id` is not a durable identifier

`messages.id` is stable for as long as the row survives, and the row does not always
survive. Two things replace a folder's rows wholesale, both of them normal events rather
than faults:

- **UIDVALIDITY changes.** The server renumbers the folder, which means every stored
  `imap_uid` now names a different message. PostIMAP deletes the folder's rows and refetches
  them, and the new rows get new UUIDs.
- **A folder is renamed on a server without the `OBJECTID` extension.** With `OBJECTID`,
  PostIMAP matches the folder by its stable `MAILBOXID` and only the name changes. Without
  it -- and many servers do not advertise it -- the rename is indistinguishable from
  deleting one folder and creating another, so the old folder is tombstoned with its rows
  attached and the new one is mirrored from scratch.

A consumer storing its own state against a message -- a classification, a label, a user
annotation -- should key it on `(account_id, message_id)`, the RFC 5322 header, which the
sender assigns once and neither event changes. `messages.id` is the right thing to join on
within a query and the wrong thing to persist as a foreign key.

### `attachments`

Binary attachment data, one row per attachment, cascade-deleted with its message.
Read-only: `filename`, `content_type`, `content_id`, `size_bytes`, `data`.

### `sync_state`

Per-account sync health: `last_full_sync`, `last_incr_sync`, `sync_tier`,
`folders_synced`, `folders_total`, `messages_synced`, `error_count`, `last_error`,
`updated_at`. Read-only, useful for a status page.

### `sync_audit`

Append-only log of what PostIMAP has processed on the outbound path, plus flag conflicts.
Nothing on the inbound path writes to it. Read-only, useful for debugging -- and purged
purely on age, so never build anything on a row surviving.

### `sync_notifications`

The durable record of a write that never reached the server. One row per operation that
gives up permanently -- never one per retry.

| column | writable | notes |
|---|---|---|
| `acknowledged_at` | update | set it when the user has seen the notification. The only writable column on this table |
| `action` | read-only | `flag_add`, `flag_remove`, `move`, `delete`, `send`, `draft` |
| `message_id`, `folder_id`, `outbox_id` | read-only | what the operation was about. Nullable, and set to NULL if the row they point at is later purged |
| `error` | read-only | the server's message, in full |
| `detail` | read-only | what was attempted, plus the subject and RFC 5322 `Message-ID` captured at the time, so the row still renders after the message it names is gone |
| `reverted_at` | read-only | set once PostIMAP has re-read that message from the server, so the mirror now shows the server's truth rather than the value that failed. NULL means it has not -- either the check could not be made, or there was nothing to put back (a failed folder create or delete, which the next `LIST` reconciles on its own). Do not render NULL as "still in progress" |
| `created_at` | read-only | |

The whole notification list for an account is one query, and it is what the partial index
on this table is built for:

```sql
SELECT * FROM sync_notifications
WHERE account_id = $1 AND acknowledged_at IS NULL
ORDER BY created_at DESC;
```

Dismissing one is `UPDATE sync_notifications SET acknowledged_at = now() WHERE id = $1`,
and "mark all as read" is the same statement with
`WHERE account_id = $1 AND acknowledged_at IS NULL`.

**Do not poll this table.** Every insert fires a `notification` event on `postimap_events`;
listen for that and re-query.

**Acknowledgement is account-wide, not per person.** PostIMAP models accounts -- mailboxes
-- and has no concept of a user. A consumer with several people sharing one mailbox builds
its own per-user read state keyed on `(account_id, sync_notifications.id)`; this column
tells it that *somebody* dealt with it.

**Retention never removes an unacknowledged row.** The purge is keyed on `acknowledged_at`,
not `created_at` (`retention.notifications_days`), so a notification nobody has seen stays
however old it gets. That is safe because a row is written only when an operation reaches a
terminal failure.

### `sync_queue`

PostIMAP's internal outbound work queue. Not part of the contract -- no grants, and the
schema of this table is not guaranteed stable across releases. If you need to know when a
message changed, listen to `postimap_events`, not this table.

### `outbox`

Send and draft composition. App-writable insert surface; PostIMAP composes the MIME
message once (nodemailer's MailComposer -- the same raw bytes are what's transmitted and
what's appended, so the Sent copy can never drift from what was actually sent), sends it
over the account's SMTP settings for `kind = 'send'`, and APPENDs a copy to the folder
with `special_use = 'sent'` (`kind = 'send'`) or `special_use = 'drafts'`
(`kind = 'draft'`). The appended message then flows back into `messages` through the
normal inbound sync path, `thread_id` included.

| column | writable | notes |
|---|---|---|
| `account_id`, `kind` | insert | `kind` is `'send'` or `'draft'` |
| `from_addr` | insert | falls back to `accounts.imap_user` if omitted |
| `to_addrs`, `cc_addrs`, `bcc_addrs`, `subject`, `body_text`, `body_html`, `in_reply_to`, `references` | insert | structured fields; PostIMAP composes the MIME |
| `status` | read-only | `pending` -> `processing` -> `sent` \| `failed` (retried) \| `dead` (retries exhausted) |
| `error`, `attempts`, `max_attempts`, `next_retry_at` | read-only | `max_attempts` defaults to 5, insertable if a row needs a tighter or looser cap; `next_retry_at` is when a `failed` row will be retried |
| `sent_message_id` | read-only | the composed Message-ID header; set the moment SMTP accepts the message, before the Sent APPEND, so a retried APPEND never resends |
| `sent_at` | read-only | set only for `kind = 'send'`; a draft's completion time is `updated_at` |

A `failed` row is retried with exponential backoff up to `max_attempts`, then moves to
`dead` -- a state visible in `status` and in the `postimap_events` `outbox`/`update`
event, not a row silently stuck retrying forever. `dead` most commonly means the account
has no `smtp_host`/`smtp_port` configured (for `kind = 'send'`) or no folder with the
expected `special_use` exists yet.

`outbox_attachments` (`outbox_id`, `filename`, `content_type`, `data`) is insert/select
only, the same pattern as `outbox` itself -- attach files before the send is picked up.

## Credentials

`imap_password` and `smtp_password` are `bytea` with a 1-byte format prefix:

- `0x00` -- the remaining bytes are the UTF-8 plaintext password.
- `0x01` -- AES-256-GCM: `[12-byte IV][ciphertext][16-byte auth tag]`.

**A consumer always writes format `0x00`.** PostIMAP is the only party that ever produces
format `0x01`, when `encryption_key` is configured. This means a consumer never
implements the encryption format at all:

```sql
UPDATE accounts SET imap_password = '\x00' || convert_to('the-plaintext-password', 'UTF8')
WHERE id = $1;
```

The format byte is authoritative on read, independent of whether a decryption key happens
to be configured, so toggling `ENCRYPTION_KEY` on an existing deployment cannot silently
corrupt stored credentials the way an unversioned format would.

**When the encryption actually happens.** PostIMAP rewrites an account's plaintext
credentials to format `0x01` when it starts syncing that account -- on service startup,
when a new account is picked up, and whenever a disabled account is re-activated. So a
credential is at rest in plaintext between the `INSERT`/`UPDATE` that writes it and the
next start of that account, and it stays plaintext for as long as an account is inactive.
A credential rewritten on an account that is already running is not re-encrypted (and not
used to reconnect) until that account restarts; toggle `is_active` to force one.

With no `encryption_key` configured, nothing is ever rewritten and credentials stay in
whatever format they were written in.

## postimap_events

One NOTIFY channel for every row change a consumer might care about, on `messages`,
`folders`, `accounts`, and `outbox`, plus the report that an outbound write never reached
the server. Every payload is valid JSON (the standard `pg-listen` library silently drops
anything that isn't).

```json
{
  "v": 1,
  "type": "message",
  "op": "update",
  "id": "9f2b...",
  "account_id": "1a3c...",
  "folder_id": "77e1...",
  "origin": "app",
  "changed": ["is_seen"]
}
```

| field | meaning |
|---|---|
| `v` | payload version, currently `1` |
| `type` | `"message"` \| `"folder"` \| `"account"` \| `"outbox"` \| `"notification"` \| `"sync_error"` |
| `op` | `"insert"` \| `"update"` \| `"delete"`, plus `"sync_complete"` for folders (see below) |
| `id` | the row's own id |
| `account_id` | always present, the account the row belongs to -- filter on this in a multi-account consumer |
| `folder_id` | present for message and folder events. On a move this is the destination |
| `old_folder_id` | the folder a message was moved out of. Present only on a message update whose `changed` includes `folder_id`, and omitted entirely otherwise |
| `origin` | `"sync"` when PostIMAP made the write, `"app"` when a consumer did |
| `changed` | which columns changed, for `op = "update"`. Message, folder and account insert/delete payloads omit the key; an outbox insert carries it as `null`. Test it for truthiness rather than presence |

Only a bounded set of columns fires an update event per type -- the ones a UI plausibly
needs to react to. High-frequency internal bookkeeping (folder `uidvalidity`/`uidnext`,
`total_count`/`unread_count`, `last_synced_at`) does not fire its own event on every sync
cycle; re-read the row (or react to a message event in that folder) if you need current
counts.

```sql
LISTEN postimap_events;
```

```python
# psycopg example
conn.execute("LISTEN postimap_events")
for notify in conn.notifies():
    event = json.loads(notify.payload)
    if event["account_id"] != my_account_id:
        continue
    ...
```

### When an outbound write fails

A write to a granted column is accepted by the database immediately and reaches the server
afterwards. Between those two moments it can fail: the folder is gone, the credential
stopped working, the server rejects the flag. PostIMAP retries with backoff, and when the
retries are exhausted it gives up on that operation permanently and says so:

```json
{ "v": 1, "type": "sync_error", "op": "dead", "id": "4021", "account_id": "1a3c...",
  "message_id": "9f2b...", "folder_id": "77e1...", "action": "flag_add",
  "error": "NO [CANNOT] Invalid flag", "origin": "sync" }
```

`id` identifies the abandoned operation, not a row in any table a consumer can read.
`message_id` follows the channel's convention of `<table>_id` naming a primary key, so it
is the `messages.id` of the row the consumer wrote -- not the `messages.message_id` header
column -- and it is what to correlate on. `action` is one of `flag_add`, `flag_remove`,
`move`, `delete`. `error` is the server's message, truncated to 500 characters. `origin`
is always `"sync"`: abandoning an operation is PostIMAP's decision, never a consumer's.

This is the only notice that a write diverged. The column in `messages` still holds the
value the consumer wrote, and it stays that way until an inbound sync reads the server's
state and overwrites it -- which arrives as an ordinary `origin: "sync"` update,
indistinguishable from someone changing the same message in another mail client. A
consumer that needs to surface "this didn't stick" has to act on this event; there is no
retry counter to poll, since `sync_queue` carries no consumer grant.

**The durable record is `sync_notifications`**, and for a general notification centre that
is the better thing to build on: it survives, it can be acknowledged, and it covers failed
sends as well as failed sync operations. Its insert fires its own event:

```json
{ "v": 1, "type": "notification", "op": "insert", "id": "17", "account_id": "1a3c...",
  "message_id": "9f2b...", "folder_id": "77e1...", "action": "flag_add", "origin": "sync" }
```

Here `id` is the `sync_notifications.id`, so the row is directly readable. Both events fire
for a failed sync operation -- `sync_error` is the older, narrower signal that names the
abandoned queue entry; `notification` names the row you can read, acknowledge and show. A
failed send fires only `notification`, plus the ordinary `outbox` update carrying
`status = 'dead'`.

**The mirror is put right immediately, and for that one message only.** A general resync
would not do it: the server never saw the write, so on a CONDSTORE or QRESYNC server there
is no change for it to report and nothing would be corrected. So PostIMAP undoes the
specific operation instead -- re-reading the message's flags from the server for a failed
flag change, restoring `folder_id` and `imap_uid` for a failed move, clearing `expunged_at`
for a failed delete -- and sets `reverted_at` once it has. A row with `reverted_at` still
NULL is one where the consumer's value may still be sitting in the column.

**A batch is not atomic, and cannot be made so.** One SQL transaction moving three messages
and flagging two becomes five independent IMAP operations, any subset of which can fail;
IMAP offers no transaction to map onto. Each gets its own notification, so it is always
clear *which* ones did not land -- but a UI must not present a batch as all-or-nothing.

### Backfill suppression

An account's initial full sync of a folder can be hundreds or thousands of messages. Firing
a `message`/`insert` event per row would mean a fresh consumer sees every piece of
historical mail as if it just arrived -- the exact failure a "does this look like a new
incoming email" classifier needs to avoid.

While a folder's first full sync is in progress, per-row `message` events are suppressed
entirely. When the folder finishes, a single event fires instead:

```json
{ "v": 1, "type": "folder", "op": "sync_complete", "id": "77e1...", "account_id": "1a3c...", "folder_id": "77e1...", "origin": "sync", "backfill": true }
```

`folders.initial_sync_done` flips to `true` at the same moment. A consumer that wants to
distinguish "this insert is backfill" from "this is new mail" doesn't need any timestamp
heuristics: subscribe, and nothing arrives per-message until `sync_complete` fires; every
message event after that point is real-time.

A later full resync of an already-synced folder (for example after a UIDVALIDITY change)
is not backfill and is not suppressed -- `initial_sync_done` only transitions once, on the
folder's first sync.

## postimap_commands

A consumer can ask PostIMAP to do something out of band:

```sql
SELECT pg_notify('postimap_commands', '{"v":1,"action":"sync","account_id":"1a3c..."}');
```

| action | payload | effect |
|---|---|---|
| `sync` | `{"account_id": "..."}` | trigger an immediate incremental sync for that account, without waiting for the next periodic cycle |

This is the only command defined in this contract version. The channel and envelope shape
(`v`, `action`) are stable; more actions may be added in later versions without breaking
existing consumers, the same way `postimap_events` is extensible by `type`.

## Search

`messages.search_vector` is a generated column over subject, from-address and body text:

```sql
to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(from_addr, '') || ' ' || coalesce(body_text, ''))
```

Each field is NULL-coalesced and space-joined, so a message with no body -- every
`is_truncated` one, for instance -- is still searchable on its subject and sender rather
than having the whole vector collapse to NULL. `'simple'` means no
stemming -- deliberate, since a mixed-language mailbox (the common case) would otherwise
have its non-English tokens corrupted by an English stemmer. A consumer wanting stemmed or
semantic search builds it on top of `body_text`; that's out of scope here by design.

```sql
SELECT id, subject FROM messages
WHERE account_id = $1 AND search_vector @@ websearch_to_tsquery('simple', $2)
ORDER BY received_at DESC;
```

## Threading

`messages.thread_id` groups a conversation. It's assigned once, at insert: PostIMAP walks
the message's `references` (closest ancestor first) then `in_reply_to`, looking each
message-id up against `(account_id, message_id)`. A match joins that thread; no match
starts a new one. If the references span two threads that were previously unrelated (this
message is the first one connecting them), every message on the newer thread is remapped
onto the older one, so the conversation converges onto a single `thread_id` even when mail
arrives out of order.

There's deliberately no subject-based fallback. References/In-Reply-To resolution is the
high-value core of RFC 5256 threading at a fraction of the implementation cost; a consumer
that needs the last few percent of edge cases RFC 5256's subject heuristics catch (mangled
or missing References headers) builds that on top of `references`/`in_reply_to`, which
stay available on every row.

```sql
SELECT id, subject, received_at FROM messages
WHERE thread_id = (SELECT thread_id FROM messages WHERE id = $1)
ORDER BY received_at;
```

## Worked examples

### Creating an account

```sql
INSERT INTO accounts (name, imap_host, imap_port, imap_user, imap_password)
VALUES (
  'me@example.com',
  'imap.example.com', 993, 'me@example.com',
  '\x00' || convert_to('hunter2', 'UTF8')
);
```

PostIMAP picks this up via `postimap_events` (`type: "account", op: "insert"`) and starts
syncing without a restart.

### Flagging a message

```sql
UPDATE messages SET is_seen = true WHERE id = $1;
```

That's the entire write. A trigger enqueues the `\Seen` STORE to IMAP; PostIMAP applies it
and the row already reflects the new state, so there's nothing to poll for.

### Moving a message

```sql
UPDATE messages SET folder_id = $2, imap_uid = NULL WHERE id = $1;
```

Several writes to one message before the queue drains are applied in the order you made
them, and a chain collapses to its net effect -- moving A to B and then to C sends one
move from A to C. Moving a message and then deleting it deletes it; there is no state in
which the intermediate hop has to have happened first. So a single transaction that moves
a message and marks it read is fine, and so is a user clicking twice quickly.

What is *not* offered is atomicity across such a batch. Each operation succeeds or fails
against the server on its own, and there is no rollback -- IMAP has no transaction to map
one onto. Treat each message's outcome as independent even when the SQL that expressed it
was a single transaction, and read [When an outbound write fails](#when-an-outbound-write-fails)
for how you learn which ones did not land.

Setting `imap_uid` to `NULL` alongside the new `folder_id` is what makes this optimistic:
the app doesn't need to know the target IMAP UID in advance (only PostIMAP learns it, after
actually executing the IMAP MOVE), and `NULL` never collides with another pending move
into the same folder under the `UNIQUE(folder_id, imap_uid)` constraint -- no sentinel
values needed. `imap_uid IS NULL` doubles as "this move hasn't completed yet." PostIMAP
writes the real UID back once the MOVE succeeds, which is reported as a `message`/`update`
event with `changed: ["imap_uid"]`, `origin: "sync"`.

A move event carries both ends -- `folder_id` is the destination and `old_folder_id` the
folder it left -- so a consumer can react to a message leaving a folder without keeping its
own copy of where every message used to be.

That covers moves made through this contract. A move performed in another mail client is a
different shape: IMAP gives the message a new UID in the destination and expunges it from
the source, and since a row is identified by `(folder_id, imap_uid)`, PostIMAP mirrors that
faithfully as an `expunged_at` update in the source folder plus an insert in the
destination, both `origin: "sync"`. There is no `folder_id` change and so no
`old_folder_id`. A consumer that needs to treat those as moves can correlate on
`message_id`, which is preserved across the pair -- deliberately left to the consumer,
since deciding whether two rows are "the same message" across folders is the cross-folder
dedup this contract does not do (see the README's non-goals).

### Deleting a message

```sql
UPDATE messages SET expunged_at = now() WHERE id = $1;
```

Enqueues an IMAP EXPUNGE. The row survives in PG (for audit/undo) with `expunged_at` set;
it drops out of `folders.total_count`/`unread_count` immediately.

### Creating a folder

```sql
INSERT INTO folders (account_id, imap_name) VALUES ($1, 'Archive/2026');
```

Enqueues an IMAP `CREATE`. IMAP has no parent-folder concept -- the hierarchy is encoded in
the name using a separator the server chooses, so build the full path yourself. Read the
separator off any existing folder of that account:

```sql
SELECT separator FROM folders WHERE account_id = $1 AND separator IS NOT NULL LIMIT 1;
```

The row exists in PG the moment you insert it, before the mailbox exists on the server.
Reconciliation knows not to tombstone it during that window. `separator`, `uidvalidity` and
the rest are filled in by the first sync after the mailbox is created.

`id` is assigned by the database -- it carries no `INSERT` grant, so read it back with
`RETURNING id` rather than choosing it. If the mailbox turns out to be impossible to create,
the queued request eventually dead-letters, you get a `sync_error` event, and the row is
tombstoned on the next reconciliation instead of staying live forever.

Creating a name that already exists on the server succeeds rather than failing: the row is
a request for a mailbox to exist under that name, not for a command to have run.

### Deleting a folder

```sql
UPDATE folders SET deleted_at = now() WHERE id = $1;
```

Enqueues an IMAP `DELETE`, **which destroys every message in that folder on the server**.
This is not a soft delete on the server side and there is no undo.

Once the server confirms the deletion, every message in that folder gets `expunged_at` set,
in the same transaction. So `expunged_at IS NULL` stays the one honest answer to "does this
mail still exist" -- there is no second condition to remember and no window in which a
normal query returns mail that is already gone. Those rows then age out under
`retention.purge_expunged_after_days` like any other expunged message.

Per-message events are suppressed for that write, the same way an initial backfill
suppresses them: the folder event already says what happened, and a large mailbox would
otherwise put one notification per message on the channel at once. React to the folder
event and re-query if you track messages individually.

A delete the server *refuses* leaves the messages untouched -- the mail is still there, and
reporting it gone would be a lie a user could disprove by opening another mail client.
Deleting `INBOX` is one such refusal: it dead-letters immediately with a `sync_error` event
rather than retrying until the attempts run out.

Clearing `deleted_at` back to `NULL` does not recreate the folder. Nothing is enqueued, and
the next reconciliation tombstones the row again because the mailbox is genuinely absent
from the server. To get the folder back, insert a new row.

### Sending mail

```sql
INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text)
VALUES ($1, 'send', '["them@example.com"]', 'Hello', 'Hi there.');
```

`status` starts `pending` and transitions to `sent`, `failed` (retrying), or `dead`
(retries exhausted); watch for the `outbox`/`update` event with `changed: ["status"]`.
`accounts.smtp_host`/`smtp_port`/`smtp_user`/`smtp_password` must be set for `kind =
'send'` -- an account with only IMAP configured can still receive drafts, but a `send`
row on it dead-letters immediately with a clear `error`.

Attach a file by inserting into `outbox_attachments` before the row is picked up:

```sql
INSERT INTO outbox (id, account_id, kind, to_addrs, subject, body_text)
VALUES ($1, $2, 'send', '["them@example.com"]', 'Invoice attached', 'See attached.');

INSERT INTO outbox_attachments (outbox_id, filename, content_type, data)
VALUES ($1, 'invoice.pdf', 'application/pdf', $3);
```

### Saving a draft

```sql
INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text)
VALUES ($1, 'draft', '["them@example.com"]', 'Draft subject', 'Still writing this...');
```

Identical shape to a send, `kind = 'draft'` instead. No SMTP send happens; PostIMAP
appends straight to the folder with `special_use = 'drafts'`. `status` still transitions
to `sent` on success -- read it as "PostIMAP finished processing this row" rather than
literally "sent", and use `updated_at` (not `sent_at`, which stays `NULL` for a draft) to
know when.

### Replying, threaded

```sql
INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text, in_reply_to, "references")
VALUES ($1, 'send', '["them@example.com"]', 'Re: Hello', 'Replying now.',
  $2, ARRAY[$2]::text[]);
```

`$2` is the original message's `message_id`. The composed reply carries that
In-Reply-To/References pair, so once the Sent copy syncs back in it resolves onto the
same `thread_id` as the message it replies to -- no separate bookkeeping needed.
