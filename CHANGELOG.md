# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Consumer-driven folder creation and deletion. An `INSERT` into `folders` creates the mailbox on the server; setting `deleted_at` deletes it. Both follow the idiom `messages` already uses for a move and an expunge, so there is no second mechanism: a trigger enqueues to `sync_queue` and skips when `postimap.writer = 'sync'`, which is what separates app intent from the folder reconciliation writing the same columns every cycle. `imap_name` carries no `UPDATE` grant -- IMAP `RENAME` also renames every child folder, so one command changes the name of an unbounded number of other rows and no single-row `UPDATE` can express it. Deleting `INBOX` is refused by IMAP and dead-letters immediately rather than retrying until the attempts run out
- A folder delete the server confirms also expunges that folder's messages, in the same transaction. IMAP `DELETE` destroys the mail outright, so those rows described messages that existed nowhere while still answering `expunged_at IS NULL` -- the predicate the rest of the contract teaches consumers to trust for live mail -- until retention hard-deleted the tombstoned folder up to `retention.purge_folders_after_days` later and the FK cascade took them. Per-row events are suppressed the way an initial backfill suppresses them, since the folder event already says what happened. A delete the server *refuses*, `INBOX` included, leaves the messages alone
- Folder reconciliation excludes folders whose create or delete is still queued. Between the consumer's write and the queue draining, PG and the server are meant to disagree, and both directions of that disagreement look exactly like an ordinary server-side change: a folder just created is absent from `LIST` and would be tombstoned, and a folder just tombstoned is still in `LIST` and would be un-tombstoned, silently cancelling the request

- `folders.subscribed` mirrors the server's subscription state, refreshed on every reconciliation cycle and read-only for a consumer. IMAP separates folders that exist from folders the user has chosen to see, and a mail client shows the subscribed ones -- PostIMAP read that field off every `LIST` response and threw it away. A change to it fires a `folder` update event like any other watched column. A server answering neither `LSUB` nor `LIST-EXTENDED` reports no subscription state at all and every mailbox comes back subscribed, so `true` means "visible", never "the user picked this one"

### Fixed
- A second write to a message while its move was still queued silently reached the server as nothing at all. An optimistic move nulls `messages.imap_uid`, so every trigger firing after the first captured NULL, and coalescing kept the *last* entry -- the one with no UID to act on. A double move dead-lettered instead of moving; a move followed by a delete neither moved nor deleted; a move followed by a flag change dropped the flag. Inside one transaction it was not a race but a certainty, and "move to Archive and mark read" is one ordinary user action. Coalescing now takes the net effect (the first entry's origin and UID, the last entry's destination), entries are applied in the order the consumer wrote them, and a message's UID is read at the moment its entry is processed rather than from the batch-claim snapshot, so an operation queued behind a move sees the UID the server assigned
- A move retried after a crash reported success while stranding the message forever. IMAP `MOVE` over a UID set that matches nothing is not an error -- the client returns a result with an empty UID map, not a failure -- so a retry of a move whose server side had already run, but whose new UID had not yet been recorded, was marked completed with `imap_uid` left NULL. Every later operation on that row needs a resolvable UID, so the message became permanently unreachable, with a successful-looking queue entry as the only trace. A move the server accepts without naming a new UID is now reconciled against the target folder by `Message-ID`: either the UID is recovered and the move completes, or the entry fails with a reason
- A move chain longer than one claim batch dead-lettered its tail. Coalescing only ever sees the entries of a single claimed batch, and it recovers a chain's source UID from the first entry -- so the eleventh move on one message landed in a later batch with no captured UID of its own and was abandoned, even though the row by then held a perfectly good one. Any bulk refiling that issues more than ten moves on a message before the queue drains hit this every time
- Every outbound branch now resolves what it acts on through one shared path -- live state, then the entry's own payload, then an explicit failure naming what is missing. A generic pre-check previously looked for a `folder_id` key that a move payload never had, rejecting moves it could have resolved from `from_folder_id`; deletes survived it only because their payload happens to use the matching name. An entry that cannot be resolved while its message row still exists is now retried rather than abandoned on the first pass, since the usual cause is a move ahead of it that has not recorded its UID yet
- Operations queued against a folder the server renumbers are abandoned instead of applied. A `UIDVALIDITY` change means UIDs were reassigned, so a captured UID can name a different message entirely -- a queued flag, move or delete would then act on mail the user never touched. They are dead-lettered, which is the state that reports `sync_error`, so the consumer learns the write never landed rather than the operation disappearing silently. A move *into* the renumbered folder is unaffected and left queued
- `purgeExpired()` reported `messagesDeleted: 0` while destroying messages. A message still attached to a folder being hard-deleted goes with it through the FK cascade and never passes the messages purge, which counts only rows it deletes by id -- so the number an operator watches to see how much mail retention removes read zero exactly when it was removing the most

## [1.2.1] - 2026-08-30

### Fixed
- A `sync_error` event reported `origin: "app"`. `OutboundProcessor.markDead` wrote the abandoned row outside a `withSyncWriter` transaction, so the trigger computed the origin from an unset writer GUC and named the consumer as the author of PostIMAP giving up on its own work -- on the one event a consumer reads to find out that PostIMAP failed. Abandoning an operation is always the sync engine's decision, and the payload now says so

## [1.2.0] - 2026-08-30

### Added
- `sync_error` events on `postimap_events` when a `sync_queue` entry exhausts its retries. A consumer's write to a granted column is accepted by the database immediately and reaches the server afterwards; when that second half fails permanently, the abandonment was recorded only in `sync_queue`, which carries no consumer grant. The column kept the value the consumer wrote until an inbound sync overwrote it, arriving as an ordinary `origin: "sync"` update indistinguishable from someone editing the same message elsewhere. The payload carries `message_id`, `action` and the server's error, truncated to 500 characters -- a `pg_notify` payload over 8000 bytes raises, which would abort the UPDATE that records the dead-lettering. `contract_version` is unchanged; a new `type` breaks no existing consumer

### Fixed
- The folder list is reconciled on every sync cycle instead of only at account start. `syncFoldersToPg` had a single call site, in `AccountSync.runStart()`; the periodic cycle read folders from PG and never asked the server what existed. A folder created in another mail client was therefore invisible for as long as the account stayed up -- not delayed, never -- and `postimap_commands` with `{"action": "sync"}` did not help, routing to the same folder-less path. Toggling `is_active` was the only way to see it. Repeated discovery costs one LIST: folders whose `MAILBOXID` is already stored are skipped by the per-folder open that reads it, and a folder found mid-cycle gets a backfill full sync so its `sync_complete` event still fires

### Changed
- `docs/consumer-contract.md` states that `messages.id` is not a durable identifier. A UIDVALIDITY change, and a folder rename on a server without `OBJECTID`, both replace a folder's rows wholesale with new UUIDs -- so a consumer persisting its own state against a message keys it on `(account_id, message_id)`, the RFC 5322 header, and treats `messages.id` as a join key rather than a foreign key
- `docs/consumer-contract.md` names `sync_state.last_full_sync` as the "has this ever worked" signal: NULL under `state = 'error'` is an account that never connected and needs a user to fix something, non-NULL is one that worked and is now failing. Both sides are asserted in the e2e suite
- `docs/consumer-contract.md` states that `error` is a retrying state rather than a dead one. Retries are unbounded and back off exponentially, and each re-resolves the host, so an account recovers on its own once the cause clears -- but the state reads the same whether it is retrying or genuinely stuck, which is enough to make a consumer treat a transient DNS failure at startup as permanent. `sync_state.error_count` is what distinguishes them

## [1.1.0] - 2026-08-30

### Added
- Message update events carry `old_folder_id` when the message moved, alongside the destination in `folder_id`. A move event previously reported only where a message landed, so a consumer reacting to one leaving a folder had to keep its own copy of every message's folder to diff against -- state this contract exists to avoid, and state that goes stale across a missed reconnect. The key is present only when `changed` includes `folder_id`, and omitted otherwise. `contract_version` is unchanged; an added field breaks no existing consumer

### Changed
- `docs/consumer-contract.md` spells out what a move made in another mail client looks like. IMAP assigns a new UID in the destination and expunges the source, and since a row is keyed on `(folder_id, imap_uid)` PostIMAP mirrors that as an expunge plus an insert -- not a `folder_id` change, and so not an `old_folder_id`. Correlating the pair on `message_id` is left to the consumer, being the cross-folder dedup this contract deliberately does not do

## [1.0.2] - 2026-08-29

Documentation only -- no code change. Several documents still described behaviour from
before the v1 rework, and each one fails quietly: the reader follows it and gets a
permission error, a missing column, or a probe weakened for a bug that no longer exists.

### Fixed
- `docs/consumer-contract.md` marked four `messages` columns as `insert, update`. There is no `INSERT` grant on `messages` at all -- a row exists because it exists on the IMAP server, and mail is created by inserting into `outbox`. The worked examples were always right; the column table was not
- `docs/consumer-contract.md` gave the `search_vector` formula without its `coalesce`/space-join, which reads as though a message with no body has a NULL vector. It does not -- a truncated message is still searchable on subject and sender
- `docs/consumer-contract.md` said the `changed` field is absent on insert and delete. It is absent for messages, folders and accounts, but an outbox insert carries it as `null`
- The chart README told consumers to `UPDATE messages.deleted_at`, which has not existed since v1 (it is `expunged_at`, and `deleted_at` is a folder column), and omitted `imap_uid` from the move
- The chart README's `/readyz` section, its `postimap_events` channel name, its account-credential example, and its claim that the PostgreSQL connection has no TLS surface were all describing an earlier version of the service
- `values.yaml` repeated the stale `/readyz` claim in a comment, contradicting the chart's own README
- The CloudNativePG example made `postimap_app` a login role, colliding with the `NOLOGIN` role the migrations create and collapsing the two-role split it exists to demonstrate. Its hand-written `GRANT` block was a second source of truth for the write contract, and had already drifted -- it granted a column that no longer exists

## [1.0.1] - 2026-08-29

### Added
- `postimap_app` can `DELETE` an account. It could add one and disable one but never remove it, so a mailbox added by mistake kept its folders, messages and attachments forever. The grant is on `accounts` alone -- every child table already cascades from it. `contract_version` is unchanged: a new permission breaks nothing a consumer already does, so check `service_version` for the capability

### Changed
- The test `ENCRYPTION_KEY` constant is a valid 64-hex key, so a test can configure encryption without silently failing key validation
- `docs/consumer-contract.md` notes that `message_id`, `in_reply_to` and `references` keep their RFC 5322 angle brackets -- matching a bare `id@host` returns zero rows rather than erroring

### Fixed
- `ENCRYPTION_KEY` now actually encrypts stored credentials. Nothing in the service ever wrote the AES-256-GCM format, so a credential a consumer wrote as plaintext stayed plaintext in the database forever, key configured or not -- and because the format byte is authoritative on read, everything kept working and nothing surfaced it. PostIMAP now rewrites plaintext credentials to AES-256-GCM when it starts an account; `docs/consumer-contract.md` states exactly when that happens and how long a credential can sit in plaintext before it does
- The Helm chart README told consumers to encrypt credentials themselves and gave an `INSERT` example with no format prefix -- both contradict the consumer contract, and the example produces an account that fails inside the sync engine rather than at insert time
- The Helm chart README claimed PostgreSQL TLS had no configuration surface and could not be pinned to a CA; `database.ssl` has both

## [1.0.0] - 2026-08-29

PostIMAP's database is now a versioned contract rather than an internal schema consumers
happened to read, and the service can send mail as well as mirror it. Consumers should read
[`docs/consumer-contract.md`](docs/consumer-contract.md) and assert `postimap_info.contract_version`
at startup.

**Upgrading from 0.2.x is a re-initialisation, not a migration.** The schema is a squashed v1
baseline: `sync_version` is gone, `deleted_at` is now `expunged_at`, `imap_uid` is nullable, and
stored credentials carry a one-byte format prefix. Point PostIMAP at an empty database and let it
re-sync from IMAP, which is authoritative.

### Changed
- The QRESYNC tier is real: the IMAP connection now enables `qresync`, and each incremental cycle forces a parameterized re-SELECT pinned to the last known UIDVALIDITY/HIGHESTMODSEQ, so deletions arrive as genuine VANISHED responses and new mail is found via a UIDNEXT-bounded range fetch. Previously it silently ran the CONDSTORE tier's CHANGEDSINCE+`UID SEARCH ALL` logic under a different log label -- functionally correct, but doing none of the work the tier exists for
- IMAP IDLE watching is bounded to `sync.idle_folders` (default `["INBOX"]`) instead of one dedicated connection per folder on the account -- an account with many folders no longer risks tripping a real provider's per-account connection cap
- Messages over `storage.max_message_bytes` (default 50 MB) are stored as envelope and flags only (`messages.is_truncated`); their body, headers, `raw_source` and attachments are never fetched from IMAP, so one oversized message can no longer materialize its full size in memory
- A periodic retention job (`retention.*` in `config/config.yaml`) hard-deletes expunged messages, long-tombstoned folders, and old completed/dead `sync_queue` rows and `sync_audit` rows past their configured windows -- previously none of these were ever purged

### Fixed
- The CONDSTORE tier's CHANGEDSINCE flag-fetch used an unconditional `"1:*"` message set, which some servers (including the pinned Dovecot test image) reject once a folder is empty -- guarded behind `mailbox.exists > 0`, the same precondition the full-diff tier already checked

### Changed
- Migrations squashed into a fresh v1 schema baseline (`001`-`005` in `src/db/migrations/`) -- no upgrade path from a pre-1.0 database; a fresh install is the only supported case
- Loop guard rebuilt: the `sync_version` column is gone, replaced by a transaction-scoped `SET LOCAL postimap.writer = 'sync'` GUC (`src/db/writer.ts`, `withSyncWriter()`). Every sync-engine write now runs inside a transaction -- previously none did
- `messages.imap_uid` is nullable, enabling an optimistic move (`UPDATE messages SET folder_id = $1, imap_uid = NULL`) in one statement with no sentinel UID values; the move trigger captures the pre-move folder/UID into the outbound queue payload
- `messages.deleted_at` renamed to `expunged_at` (it means "gone from the IMAP server", distinct from the `\Deleted` flag)
- `folders` soft-delete via `deleted_at`: a folder absent from a LIST response is tombstoned, not hard-deleted, so a flaky or partial LIST can no longer cascade-delete a folder's mirrored messages and attachments; it un-tombstones if the folder reappears
- Folder `total_count`/`unread_count` trigger rewritten as a delta computation (visibility/unread computed independently for OLD and NEW, then applied as one diff), fixing a permanent under-count on un-expunge that the previous `ELSIF` chain never handled
- `messages.search_vector` is now a `GENERATED ALWAYS AS (...) STORED` column against the `'simple'` text search dictionary, replacing a trigger-maintained `'english'` column -- `'simple'` doesn't stem, which is the correct default for mixed-language mail
- `to_addrs`, `cc_addrs`, `bcc_addrs`, `raw_headers`, and `accounts.capabilities` are written as native objects, not pre-`JSON.stringify`'d strings -- these jsonb columns are now actually queryable with `->`/`@>`/GIN indexes instead of holding a JSON string inside a JSON value
- Credential storage gains a 1-byte format prefix on `imap_password`/`smtp_password` (`0x00` plaintext UTF-8, `0x01` AES-256-GCM); a consumer always writes `0x00` and never implements the encryption format
- The `account_changes` NOTIFY channel is folded into `postimap_events` (`type: "account"`)
- `npm run migrate` reads the same config chain (`config.yaml` -> override -> env) as the running service via `getDatabaseUrl(loadConfig())`, instead of requiring a standalone `DATABASE_URL`
- The outbound queue claim (`SELECT ... FOR UPDATE SKIP LOCKED` + the `status = 'processing'` mark) runs in one transaction instead of two autocommitted statements, so the row lock actually covers both -- a second replica racing the claim can no longer double-process an entry
- Node.js floor raised to 24 (LTS); Dockerfile base image, CI, and `@types/node` updated to match
- Dependency backlog taken across the board: `zod` 4, `pino` 10, `@biomejs/biome` 2, `testcontainers` / `@testcontainers/postgresql` 12, `typescript` 7, `kysely` 0.29, `kysely-postgres-js` 4, `toxiproxy-node-client` 4, plus routine minor/patch bumps across the rest
- `kysely`'s `Migrator`/`FileMigrationProvider` now imported from `kysely/migration` (moved off the main entry point in 0.29)
- `biome.json` migrated to the v2 config schema (`assist.actions.source.organizeImports`, `linter.rules.preset`, `files.includes`)
- Test containers: `postgres` image to 18-alpine (mounts now at `/var/lib/postgresql`, not `/var/lib/postgresql/data`, per the 18.x image layout change), `ghcr.io/shopify/toxiproxy` to 2.12.0
- Test mail server switched from Stalwart (whose Docker Hub repo is abandoned at v0.11.8, with no CONDSTORE/QRESYNC support) to `dovecot/dovecot:2.4.5`, which advertises both -- the two previously-untested sync tiers in `change-detector.ts` are now exercised for real, both at the IMAP-integration and unit level
- Toxiproxy test container healthcheck removed -- the 2.12.0 image ships only the `toxiproxy` binary (no shell, no wget), so callers poll the HTTP API directly instead
- Test containers are now testcontainers-only: the podman-compose fallback, `.env.test`, and `compose.test.yaml`/`compose.dev.yaml` are gone. `tests/setup/global-setup.ts` wires the podman socket automatically and reuses containers between local runs (disabled in CI)
- CI split into a fast path (lint, unit, integration, e2e) on every push/PR and a nightly + tag-triggered run for chaos/property
- E2E suite consolidated from 17 single-assertion files to 5 scenario files sharing setup per scenario
- Test mail delivery now goes over LMTP (implicit TLS) instead of authenticated SMTP submission, matching what the mail server actually offers for local delivery; this only affects how tests seed inbound mail, distinct from the outbox's own SMTP send path
- Test accounts authenticate with one shared password (`MAIL_PASSWORD` in `tests/setup/env.ts`) instead of per-test passwords, since the mail server has no account-provisioning API -- any username authenticates and gets its mailbox created on first login
- Pino logger silenced during tests (`LOG_LEVEL=silent`) instead of dumping raw JSON

### Added
- `messages.is_truncated` (migration 006) -- set when a message exceeded `storage.max_message_bytes` at fetch time; `docs/consumer-contract.md` documents which columns stay NULL as a result
- Config: `sync.idle_folders`, `storage.max_message_bytes`, `retention.interval_hours`/`purge_expunged_after_days`/`purge_folders_after_days`/`audit_days`
- `docs/consumer-contract.md` -- the versioned public contract: tables, exactly which columns a consumer may write, `postimap_events` payload shapes, the `postimap_commands` channel, the credential format, and worked SQL examples for creating an account, flagging, moving, deleting, and sending mail
- `postimap_events` NOTIFY channel on `messages`/`folders`/`accounts`/`outbox`, carrying `origin: "sync" | "app"` and suppressing per-row message events during a folder's initial full sync (one `sync_complete` event fires instead) -- fixes the class of bug where a fresh account's entire mail history looks identical to genuinely new incoming mail
- `postimap_info` single-row table for the `contract_version`/`service_version` handshake
- `postimap_app` NOLOGIN role with column-level `GRANT`s -- the write contract enforced by PostgreSQL itself, not by convention
- `outbox`/`outbox_attachments` tables and the send/draft engine that consumes them (`src/sync/outbox.ts`): a `pending` row is composed once via nodemailer's `MailComposer`, sent over the account's SMTP settings for `kind = 'send'`, and the same raw bytes are appended to the `special_use = 'sent'`/`'drafts'` folder -- one mechanism covers both a real send and a draft. NOTIFY-driven (`outbox_{account_id}`) with polling fallback and `status = 'dead'` after `max_attempts` retries, mirroring the outbound queue
- `messages.thread_id`, resolved on insert (`src/protocol/threading.ts`): walks `references` then `in_reply_to` against `(account_id, message_id)`, merging onto the older thread when a message bridges two previously-unrelated ones. No subject-based fallback, by design -- see `docs/consumer-contract.md`
- `nodemailer` (dependency) and `@types/nodemailer` (dev) -- MIME composition for the outbox
- Third test container, `axllent/mailpit`: a real SMTP sink with an HTTP API, so outbox e2e tests prove an actual send instead of mocking the transport (`tests/setup/mailpit-helpers.ts`)
- `renovate.json` custom regex manager tracking the container image strings in `tests/setup/global-setup.ts`
- Release workflow now fails if the pushed tag doesn't match `package.json`'s version
- `tests/unit/change-detector.test.ts` covers the QRESYNC and CONDSTORE tiers (previously only the full-diff tier had unit coverage) via a stubbed IMAP client
- `scripts/test-infra-down.sh` (`npm run test:infra:down`) removes containers/networks left behind by reuse
- TLS support for the PostgreSQL connection (`database.ssl.enabled`/`reject_unauthorized`/`ca_file` in `config.yaml`), plumbed through `createDatabase()` and the `migrate` CLI -- required for the Kubernetes/CloudNativePG deployment story
- Custom IMAP keywords/labels now sync outbound: `flag_add`/`flag_remove` per changed keyword, using the same machinery as the system flags

### Fixed
- Account startup and periodic sync are now fail-fast: helpers throw, `AccountSync.start()`/`periodicSync()` are the only catch points, and a connection-level failure aborts the rest of the cycle instead of repeating the same failure once per remaining folder (previously the source of a null-deref crash once `this.capabilities` or a folder's discovery data never got set)
- `AccountSync.stop()` now cancels an in-flight `start()`/`periodicSync()` via `AbortSignal` and waits for it to actually return before disconnecting, instead of only setting a flag nothing checked -- a shutdown mid-initial-sync of a large mailbox previously blocked for as long as the sync took (tens of seconds), which meant `SIGTERM` in Kubernetes was effectively ignored until the pod was `SIGKILL`ed
- Custom keywords/labels were 100% dead-lettered on first touch: the trigger enqueued `{keywords_old, keywords_new}` under `flag_add`, a payload shape the outbound handler couldn't read
- `logging.level` from config is now applied to the logger at startup; `LOG_LEVEL` remains a supported override
- `/readyz` no longer requires at least one active account -- it reports ready once the database is reachable and the orchestrator has started, so a fresh deployment with zero accounts (or one that's mid-retry) is correctly Ready in Kubernetes
- A logout that loses its race against the 5s disconnect timeout no longer surfaces as an unhandled promise rejection (`imap/pool.ts`, `sync/idle-watcher.ts`)
- A stale mailbox lock handle could release a different, just-acquired lock on the UIDVALIDITY-changed resync path in `InboundSync.syncFolder` -- fixed by guarding the release with a once-only flag
- A UIDVALIDITY change now hard-deletes the folder's message rows before refetching instead of upserting new messages onto old row ids, which previously could silently attach fresh mail to an unrelated pre-existing row (and any consumer foreign keys pointing at it)
- Folder reconciliation treats a LIST returning zero folders for an account that has existing folders as an error instead of soft-deleting all of them

### Removed
- `messages.sync_version` and `folders.exists_count` -- the loop guard no longer needs a per-row counter, and `exists_count` was internal bookkeeping nothing read
- `@faker-js/faker` and `fishery` -- the generic record factories they backed were unused; only the hand-written MIME builders in `tests/factories/mime.ts` were ever imported
- 6 of 14 `.eml` fixtures that nothing referenced; `StalwartAdmin.waitReady()`, which was defined and never called

## [0.2.1] - 2026-04-03

### Fixed
- Orchestrator restart loop triggered by state-transition NOTIFYs
- `migrate.ts` CLI entrypoint guard to prevent execution on import

## [0.2.0] - 2026-04-01

### Added
- AES-256-GCM credential encryption for stored IMAP/SMTP passwords (`ENCRYPTION_KEY`)

## [0.1.0] - 2026-03-25

### Added
- Bidirectional IMAP-to-PostgreSQL sync engine
- Three-tier IMAP change detection (QRESYNC/CONDSTORE/full diff)
- sync_version-based loop prevention with PG triggers
- Multi-account orchestrator with per-account state machine
- IMAP IDLE watcher with auto-restart
- Outbound queue processor with coalescing and CONDSTORE optimistic locking
- Full MIME parsing with attachment storage
- /healthz and /readyz HTTP health endpoints
- Crash recovery on startup
- Structured JSON logging (pino)
- YAML-based config loader with three-layer merge (default YAML, custom override, env vars); `config/config.yaml` is the single source of truth for defaults
- `config-custom/` directory for deployment-specific overrides
- `compose.yaml` / `compose.dev.yaml` -- production and development compose files
- `POSTIMAP_*` env var overrides for any config value (e.g., `POSTIMAP_DATABASE_HOST`)
- Database connection composed from individual fields (host, port, name, user, password) via `getDatabaseUrl()`
- Comprehensive test suite: 143 tests across 6 layers (unit, PG integration, IMAP integration, E2E, chaos, property)
- Toxiproxy-based chaos testing (network partition, slow responses)
- fast-check property testing (convergence, idempotency, loop-bounded)
- Dual-mode test containers (compose for local, testcontainers for CI)
- GitHub Actions CI pipeline with parallel test execution
- Dockerfile with multi-stage build
- Renovate for automated dependency updates
