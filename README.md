<table>
<tr>
<td width="140">
<img src="docs/logo.png" alt="PostIMAP" width="120">
</td>
<td>
<h1>PostIMAP</h1>
Bidirectional IMAP-to-PostgreSQL sync microservice.
</td>
</tr>
</table>

[![CI](https://github.com/frederikb96/postimap/actions/workflows/ci.yaml/badge.svg)](https://github.com/frederikb96/postimap/actions/workflows/ci.yaml)
[![Release](https://img.shields.io/github/v/release/frederikb96/postimap)](https://github.com/frederikb96/postimap/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

PostIMAP is a dumb full-replication IMAP-to-PostgreSQL mirror. It replicates all messages, bodies, and attachments from IMAP mailboxes into PostgreSQL tables — bidirectionally. Apps interact with email data purely through SQL; PostIMAP handles IMAP protocol invisibly in the background.

## Why

- **IMAP is slow and complex** — 40-year-old protocol with inconsistent server implementations. PostIMAP absorbs that complexity so your app doesn't have to.
- **PG is the only interface** — no REST API, no SDK. Your app reads/writes SQL. PostIMAP watches for changes via PG triggers and syncs them to IMAP.
- **Full replication** — PG always has a complete copy. No on-demand fetching, no lookback windows, no lazy loading. `SELECT * FROM messages` gives you everything.
- **Bidirectional** — mark a message as read in PG (`UPDATE messages SET is_seen = true`) and PostIMAP propagates `\Seen` to IMAP. New email arrives on IMAP and PostIMAP inserts it into PG.

## Quick Start

```bash
npm install
npm run test:unit         # fast, no containers needed
npm test                  # full suite -- spins up PG + Dovecot + Toxiproxy via testcontainers
```

Tests need a container runtime reachable as Docker (Docker itself, or rootless Podman with
`systemctl --user enable --now podman.socket`) -- nothing else to start by hand.

## How It Works

```
App writes SQL ──► PG triggers ──► sync_queue ──► PostIMAP ──► IMAP server
                                                                    │
App reads SQL  ◄── PG tables  ◄── PostIMAP  ◄── IDLE/poll ◄────────┘
```

- **Inbound** (IMAP → PG): Three-tier change detection — QRESYNC, CONDSTORE, or full UID diff (auto-selected per server). IDLE for near-real-time notification.
- **Outbound** (PG → IMAP): AFTER UPDATE triggers detect app changes, enqueue to `sync_queue`, NOTIFY wakes the outbound processor. Supports flag changes, moves, and deletes.
- **Loop prevention**: sync-engine writes run inside a transaction with `SET LOCAL postimap.writer = 'sync'`; triggers skip enqueueing when it's set, so there's no per-row column for an app to accidentally touch.
- **Conflict resolution**: IMAP is authoritative. When in doubt, IMAP state wins.
- **Change notification**: one versioned `postimap_events` channel covers messages, folders, accounts, and outbox — see [`docs/consumer-contract.md`](docs/consumer-contract.md) for the full write contract, payload shapes, and worked examples. That document, not this README, is the source of truth for what a consumer may read and write.

## Non-goals

Deliberately out of scope, to keep "dumb mirror + outbox" the whole product:

- Quota enforcement
- Cross-folder message dedup — a `folder_id` + `imap_uid` row *is* the mirrored object; a server that duplicates a message across folders (e.g. Gmail's All Mail) gets mirrored faithfully, not collapsed
- Server-side search beyond the `search_vector` tsvector column — semantic/embedding search is a consumer concern
- POP3, JMAP, calendars, contacts

## Configuration

All defaults and options are in [`config/config.yaml`](config/config.yaml) — the single source of truth for configuration. Three layers merge at startup (highest priority wins):

- **`config/config.yaml`** — defaults, bundled in Docker image
- **`config-custom/config.override.yaml`** — sparse overrides per deployment (mounted at runtime)
- **Environment variables** — `${VAR}` placeholder resolution + `POSTIMAP_SECTION_KEY` overrides (e.g., `POSTIMAP_DATABASE_HOST`)

Secrets use `${VAR}` placeholders in the YAML, resolved from environment variables at startup. Required secrets:

- `DB_PASSWORD` — PostgreSQL password
- `ENCRYPTION_KEY` — credential encryption key (optional; unset means stored credentials stay in plaintext format)

Accounts are managed by inserting into the `accounts` table — PostIMAP detects new accounts via PG NOTIFY and starts syncing automatically.

## Running

```bash
cp .prod.env.example .prod.env   # Fill in real secrets
podman compose --env-file .prod.env -f compose.yaml up -d
```

Health checks: `GET /healthz` (liveness — process is up), `GET /readyz` (readiness — database reachable and the orchestrator has started; a fresh deployment with zero accounts yet, or one that's mid-retry, is correctly Ready).

## Schema

PostIMAP creates and manages these tables via Kysely migrations. See
[`docs/consumer-contract.md`](docs/consumer-contract.md) for exactly which columns a
consumer may write.

- **`accounts`** — IMAP/SMTP credentials, connection state machine
- **`folders`** — IMAP folder list with UIDVALIDITY/MODSEQ tracking, soft-deleted (never cascaded) when absent from a LIST
- **`messages`** — Full message data: headers, bodies, flags; nullable `imap_uid` for optimistic moves; `expunged_at` for soft-delete
- **`attachments`** — Binary attachment data
- **`sync_queue`** — Pending outbound operations (flag changes, moves, deletes) — internal, not part of the consumer contract
- **`sync_state`** — Per-account sync progress and health
- **`sync_audit`** — Append-only log of all sync events
- **`outbox`** / **`outbox_attachments`** — Send and draft composition
- **`postimap_info`** — Single-row contract-version handshake

## Testing

Six layers, fastest first:

- **Unit** — UID parsing, change detection (including the QRESYNC/CONDSTORE tiers, mocked), MIME parsing, coalescing. No containers.
- **PG Integration** — triggers, NOTIFY, loop guard, crash recovery
- **IMAP Integration** — connect, capabilities (asserts the test server genuinely advertises CONDSTORE/QRESYNC), folder discovery, IDLE
- **E2E** — full bidirectional sync with real PG + Dovecot
- **Chaos** — network partition and slow responses via Toxiproxy
- **Property** — fast-check convergence, idempotency, loop-bounded

CI runs everything except Chaos and Property on every push; those two run nightly and on
release tags (see `.github/workflows/`) since they're slow and don't gate merges.

## Tech Stack

- **TypeScript** on Node.js 22+ LTS
- **ImapFlow** — production-proven IMAP client (powers EmailEngine)
- **postgres.js** + **pg-listen** — PG driver with LISTEN/NOTIFY
- **Kysely** — type-safe SQL query builder and migrations
- **mailparser** — RFC 2822/MIME parsing (same author as ImapFlow)
- **pino** — structured JSON logging
- **Dovecot** — test IMAP server
- **Toxiproxy** — network fault injection for chaos tests

## License

[MIT](LICENSE) — Frederik Berg
