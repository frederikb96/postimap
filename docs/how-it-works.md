# How it works

What PostIMAP does between the mail server and the database. What a consumer may read and write
is [consumer-contract.md](consumer-contract.md); this page is the machinery behind it.

```
App writes SQL ──► PG triggers ──► sync_queue ──► PostIMAP ──► IMAP server
                                                                    │
App reads SQL  ◄── PG tables  ◄── PostIMAP  ◄── IDLE/poll ◄────────┘
```

IMAP is authoritative: PostgreSQL is a cache of the server's state plus a queue of pending
outbound changes. When in doubt, the server's state wins.

## Inbound: IMAP to PostgreSQL

- **Three-tier change detection**: QRESYNC, CONDSTORE, or a full UID diff, selected per server
  from its advertised capabilities. Each tier reads only the mirrored state it actually consults,
  so the fast paths cost as much as what *changed* rather than as much as the folder holds.
- The QRESYNC tier re-SELECTs pinned to the last known UIDVALIDITY/HIGHESTMODSEQ, so deletions
  arrive as VANISHED and new mail is found by a bounded UIDNEXT-range fetch — no UID SEARCH on
  that path.
- The full-diff tier skips a cycle whose mailbox counters have not moved, bounded by
  `sync.full_tier_max_skip_seconds`.
- **IDLE** gives near-real-time notification. It is requested per folder via
  `folders.idle_requested` and reported back in `folders.idle_status`. Each watched folder holds
  its own dedicated connection, and every provider caps how many an account may hold, so
  `sync.idle_folders` only seeds the default once. A watch that gives up reconnecting says so on
  the row and raises a notification instead of quietly ceasing to be real-time.
- A message over `storage.max_message_bytes` is stored as envelope and flags only
  (`is_truncated = true`) rather than buffered in full.
- **A full sync** fetches only the messages PostgreSQL is missing and expunges the ones the server
  no longer has, so an account restart costs one `SEARCH` per folder rather than a re-download of
  every body. It still repairs a message missing from the middle of a folder, which the
  incremental path cannot see.

## Folders

The folder list is reconciled from the server's `LIST` on every sync cycle, so a folder created or
removed in another mail client shows up without restarting anything. A server advertising
`OBJECTID` also gets rename detection via the stable `MAILBOXID`.

A consumer creates a folder by inserting a `folders` row and deletes one by setting
`deleted_at` — the same idiom `messages` uses for moves and deletes. Renaming is deliberately not
offered: IMAP `RENAME` also renames every child folder, which no single-row `UPDATE` can express.

## Outbound: PostgreSQL to IMAP

- AFTER UPDATE triggers detect a consumer's changes, enqueue them to `sync_queue`, and a NOTIFY
  wakes the outbound processor. Flag changes, moves and deletes are supported.
- **Loop prevention:** sync-engine writes run inside a transaction with
  `SET LOCAL postimap.writer = 'sync'`, and the triggers skip enqueueing when it is set. There is
  no per-row column for an app to touch by accident.
- An operation whose retries are exhausted is reported on `postimap_events` as a `sync_error` —
  the only notice a consumer gets that its write never reached the server.

## Outbox: sending and drafts

- An `outbox` insert is composed once (nodemailer), sent over the account's SMTP settings for
  `kind = 'send'`, and appended to the `special_use = 'sent'` or `'drafts'` folder. The same
  mechanism covers both a real send and saving a draft.
- A row may name the message it replaces (`replaces_message_id`), which is how a draft is edited
  without accumulating a copy per save. The replacement is appended before the old message is
  removed, and the removal rides the ordinary outbound delete path, so it retries and reports
  failure like any other write.
- A third kind, `'append'`, composes and sends nothing. It APPENDs a row's own `raw_source` bytes
  to a chosen folder with given flags and an internal date, for putting a message a consumer kept
  only in its own storage back onto the server exactly as it was.

## Threading

`messages.thread_id` is resolved on insert from `references`/`in_reply_to` against
`(account_id, message_id)`, so a reply chain converges onto one `thread_id` however it arrives.

## Calendars and contacts

CalDAV and CardDAV get the same shape in `dav_accounts`, `dav_collections` and `dav_objects`:

- discovery from one URL;
- a per-collection change-detection tier: RFC 6578 `sync-collection`, `getctag`, or an etag diff;
- conditional writes, with the server winning a conflict;
- a periodic full etag reconcile that catches a server silently accepting a stale token.

An object row is the whole iCalendar or vCard resource; recurrence is a consumer's to expand.

## Change notification

One versioned `postimap_events` channel covers messages, folders, accounts, the outbox and the DAV
tables. The payload shapes and worked examples are in
[consumer-contract.md](consumer-contract.md#postimap_events).

## Retention

A periodic job hard-deletes expunged messages, long-tombstoned folders, and old `sync_queue` and
`sync_audit` rows past their configured windows (`retention.*` in
[`config/config.yaml`](../config/config.yaml)). Without it the mirror grows forever.

## Tables

PostIMAP creates and manages these tables via Kysely migrations. Which columns a consumer may
write is in [consumer-contract.md](consumer-contract.md).

- **`accounts`** — IMAP/SMTP credentials, connection state machine
- **`folders`** — IMAP folder list with UIDVALIDITY/MODSEQ tracking, soft-deleted (never
  cascaded) when absent from a LIST; `backfill_total` and `total_count` give a first sync a live
  progress reading
- **`messages`** — full message data: headers, bodies, flags; nullable `imap_uid` for optimistic
  moves; `expunged_at` for soft-delete; `thread_id` groups a conversation; `is_truncated` marks a
  message stored as envelope and flags only because it exceeded `storage.max_message_bytes`
- **`attachments`** — binary attachment data
- **`sync_queue`** — pending outbound operations (flag changes, moves, deletes); internal, not part
  of the consumer contract
- **`sync_state`** — per-account sync progress and health
- **`sync_audit`** — append-only log of all sync events
- **`outbox`** / **`outbox_attachments`** — send and draft composition, plus appending a message's
  own bytes onto the server verbatim
- **`postimap_info`** — single-row contract-version handshake
- **`dav_accounts`** / **`dav_collections`** / **`dav_objects`** — CalDAV/CardDAV credentials and
  discovered homes, calendars and address books with their sync tier and token, and one row per
  resource holding the verbatim body plus parsed columns; `dav_notifications` records a DAV write
  that never landed, `dav_sync_queue` is the internal outbound queue
