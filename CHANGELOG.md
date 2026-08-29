# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Test mail delivery now goes over LMTP (implicit TLS) instead of authenticated SMTP submission, matching what the mail server actually offers for local delivery; PostIMAP itself never speaks SMTP/LMTP, so this only affects how tests seed inbound mail
- Test accounts authenticate with one shared password (`MAIL_PASSWORD` in `tests/setup/env.ts`) instead of per-test passwords, since the mail server has no account-provisioning API -- any username authenticates and gets its mailbox created on first login
- Pino logger silenced during tests (`LOG_LEVEL=silent`) instead of dumping raw JSON

### Added
- `docs/consumer-contract.md` -- the versioned public contract: tables, exactly which columns a consumer may write, `postimap_events` payload shapes, the `postimap_commands` channel, the credential format, and worked SQL examples for creating an account, flagging, moving, deleting, and sending mail
- `postimap_events` NOTIFY channel on `messages`/`folders`/`accounts`/`outbox`, carrying `origin: "sync" | "app"` and suppressing per-row message events during a folder's initial full sync (one `sync_complete` event fires instead) -- fixes the class of bug where a fresh account's entire mail history looks identical to genuinely new incoming mail
- `postimap_info` single-row table for the `contract_version`/`service_version` handshake
- `postimap_app` NOLOGIN role with column-level `GRANT`s -- the write contract enforced by PostgreSQL itself, not by convention
- `outbox`/`outbox_attachments` tables (schema only; the compose/SMTP-send/Sent-APPEND logic that consumes them ships separately)
- `renovate.json` custom regex manager tracking the container image strings in `tests/setup/global-setup.ts`
- Release workflow now fails if the pushed tag doesn't match `package.json`'s version
- `tests/unit/change-detector.test.ts` covers the QRESYNC and CONDSTORE tiers (previously only the full-diff tier had unit coverage) via a stubbed IMAP client
- `scripts/test-infra-down.sh` (`npm run test:infra:down`) removes containers/networks left behind by reuse

### Removed
- `messages.sync_version` and `folders.exists_count` -- the loop guard no longer needs a per-row counter, and `exists_count` was internal bookkeeping nothing read
- `@faker-js/faker` and `fishery` -- the generic record factories they backed were unused; only the hand-written MIME builders in `tests/factories/mime.ts` were ever imported
- `nodemailer` -- the test harness delivers mail over LMTP directly instead of SMTP
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
