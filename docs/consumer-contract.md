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
| `state` | read-only | `created` \| `syncing` \| `active` \| `error` \| `disabled`, PostIMAP-managed |
| `state_error` | read-only | last error message when `state = 'error'` |
| `capabilities` | read-only | detected server capabilities, jsonb |
| `created_at` | read-only | |
| `updated_at` | read-only | maintained automatically on every update |

Inserting a row is how you add an account. PostIMAP detects it via `postimap_events`
(`type: "account", op: "insert"`) and starts syncing without a restart.

### `folders`

The IMAP folder list for an account, one row per mailbox.

| column | writable | notes |
|---|---|---|
| `imap_name`, `display_name`, `separator`, `mailbox_id`, `special_use` | read-only | |
| `uidvalidity`, `uidnext`, `highestmodseq` | read-only | IMAP sync bookkeeping |
| `total_count`, `unread_count` | read-only | maintained by trigger on every message change |
| `last_synced_at`, `sync_error` | read-only | |
| `deleted_at` | read-only | set when the folder is absent from the server's LIST; cleared if it reappears. A tombstoned folder's rows are never destroyed by a flaky LIST response |
| `initial_sync_done` | read-only | flips true once the folder's first full sync completes -- see [Backfill suppression](#backfill-suppression) |

Folders are entirely PostIMAP-managed. There is no consumer write surface here yet; folder
creation from PG is a documented non-goal for this contract version (see the
[README](../README.md) for the full non-goals list).

### `messages`

The mirrored message. Full envelope, parsed body, and flags.

| column | writable | notes |
|---|---|---|
| `id` | read-only | UUID |
| `account_id`, `folder_id` | read-only\* | `folder_id` is writable -- see [Moving a message](#moving-a-message) |
| `imap_uid` | writable\* | nullable; NULL means an optimistic move is pending -- see below |
| `message_id`, `subject`, `from_addr`, `to_addrs`, `cc_addrs`, `bcc_addrs`, `reply_to`, `in_reply_to`, `references` | read-only | native jsonb/array, not double-encoded strings |
| `body_text`, `body_html`, `raw_headers`, `raw_source` | read-only | `raw_source` is the full RFC822 bytea; NULL when `is_truncated` |
| `received_at`, `size_bytes`, `modseq` | read-only | |
| `is_truncated` | read-only | `true` when the message exceeded `storage.max_message_bytes` at fetch time -- `body_text`/`body_html`/`raw_headers`/`raw_source` and any attachments were never fetched from IMAP and stay NULL/empty; `subject`/`from_addr`/`to_addrs`/etc. are still populated from the envelope |
| `is_seen`, `is_flagged`, `is_answered` | insert, update | maps to `\Seen`, `\Flagged`, `\Answered` |
| `is_draft`, `is_deleted` | insert, update | maps to `\Draft` and `\Deleted`. Setting `is_deleted` marks the message for deletion without removing it; use `expunged_at` to actually remove it |
| `keywords` | insert, update | custom IMAP keywords/labels, `text[]` |
| `expunged_at` | insert, update | set to soft-delete (see [Deleting a message](#deleting-a-message)); distinct from the `\Deleted` flag, which just marks the message for deletion without removing it |
| `search_vector` | read-only | generated column, `to_tsvector('simple', ...)` over subject/from/body -- see [Search](#search) |
| `thread_id` | read-only | groups a conversation -- see [Threading](#threading) |
| `created_at`, `updated_at` | read-only | `updated_at` changes on any write, PostIMAP's or the app's |

\* `folder_id` and `imap_uid` are writable together as the move operation; see below.
Everything else in this table is written exclusively by PostIMAP's sync engine.

### `attachments`

Binary attachment data, one row per attachment, cascade-deleted with its message.
Read-only: `filename`, `content_type`, `content_id`, `size_bytes`, `data`.

### `sync_state`

Per-account sync health: `last_full_sync`, `last_incr_sync`, `sync_tier`,
`folders_synced`, `folders_total`, `messages_synced`, `error_count`, `last_error`,
`updated_at`. Read-only, useful for a status page.

### `sync_audit`

Append-only log of every inbound/outbound/conflict event PostIMAP has processed. Read-only,
useful for debugging.

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
to be configured -- toggling `ENCRYPTION_KEY` on an existing deployment can no longer
silently corrupt stored credentials the way an unversioned format would.

## postimap_events

One NOTIFY channel for every row change a consumer might care about, on `messages`,
`folders`, `accounts`, and `outbox`. Every payload is valid JSON (the standard `pg-listen`
library silently drops anything that isn't).

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
| `type` | `"message"` \| `"folder"` \| `"account"` \| `"outbox"` |
| `op` | `"insert"` \| `"update"` \| `"delete"`, plus `"sync_complete"` for folders (see below) |
| `id` | the row's own id |
| `account_id` | always present, the account the row belongs to -- filter on this in a multi-account consumer |
| `folder_id` | present for message and folder events |
| `origin` | `"sync"` when PostIMAP made the write, `"app"` when a consumer did |
| `changed` | which columns changed, for `op = "update"`; absent for insert/delete |

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

`messages.search_vector` is a generated column,
`to_tsvector('simple', subject || from_addr || body_text)`. `'simple'` means no
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

Setting `imap_uid` to `NULL` alongside the new `folder_id` is what makes this optimistic:
the app doesn't need to know the target IMAP UID in advance (only PostIMAP learns it, after
actually executing the IMAP MOVE), and `NULL` never collides with another pending move
into the same folder under the `UNIQUE(folder_id, imap_uid)` constraint -- no sentinel
values needed. `imap_uid IS NULL` doubles as "this move hasn't completed yet." PostIMAP
writes the real UID back once the MOVE succeeds, which is reported as a `message`/`update`
event with `changed: ["imap_uid"]`, `origin: "sync"`.

### Deleting a message

```sql
UPDATE messages SET expunged_at = now() WHERE id = $1;
```

Enqueues an IMAP EXPUNGE. The row survives in PG (for audit/undo) with `expunged_at` set;
it drops out of `folders.total_count`/`unread_count` immediately.

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
