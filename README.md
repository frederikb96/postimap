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
npm run infra:up          # Start PG + Stalwart + Toxiproxy (podman compose)
npm run test:unit         # 85 tests, <1s, no containers needed
npm test                  # All 143 tests across 6 suites
```

## How It Works

```
App writes SQL ──► PG triggers ──► sync_queue ──► PostIMAP ──► IMAP server
                                                                    │
App reads SQL  ◄── PG tables  ◄── PostIMAP  ◄── IDLE/poll ◄────────┘
```

- **Inbound** (IMAP → PG): Three-tier change detection — QRESYNC, CONDSTORE, or full UID diff (auto-selected per server). IDLE for near-real-time notification.
- **Outbound** (PG → IMAP): AFTER UPDATE triggers detect app changes, enqueue to `sync_queue`, NOTIFY wakes the outbound processor. Supports flag changes, moves, and deletes.
- **Loop prevention**: Monotonic `sync_version` counter on each message row. Triggers skip enqueueing when PostIMAP (not the app) made the change.
- **Conflict resolution**: IMAP is authoritative. When in doubt, IMAP state wins.

## Configuration

All defaults and options are in [`config/config.yaml`](config/config.yaml) — the single source of truth for configuration. Three layers merge at startup (highest priority wins):

- **`config/config.yaml`** — defaults, bundled in Docker image
- **`config-custom/config.override.yaml`** — sparse overrides per deployment (mounted at runtime)
- **Environment variables** — `${VAR}` placeholder resolution + `POSTIMAP_SECTION_KEY` overrides (e.g., `POSTIMAP_DATABASE_HOST`)

Secrets use `${VAR}` placeholders in the YAML, resolved from environment variables at startup. Required secrets:

- `DB_PASSWORD` — PostgreSQL password
- `ENCRYPTION_KEY` — credential encryption key (optional, not yet implemented)

Accounts are managed by inserting into the `accounts` table — PostIMAP detects new accounts via PG NOTIFY and starts syncing automatically.

## Running

**Production** (with compose):

```bash
cp .prod.env.example .prod.env   # Fill in real secrets
podman compose --env-file .prod.env -f compose.yaml up -d
```

**Development** (local build + Stalwart):

```bash
cp .dev.env.example .dev.env
podman compose --env-file .dev.env -f compose.dev.yaml up -d
```

Health checks: `GET /healthz` (liveness), `GET /readyz` (readiness — at least one account actively syncing).

## Schema

PostIMAP creates and manages these tables via Kysely migrations:

- **`accounts`** — IMAP/SMTP credentials, connection state machine
- **`folders`** — IMAP folder list with UIDVALIDITY/MODSEQ tracking
- **`messages`** — Full message data: headers, bodies, flags, `sync_version`
- **`attachments`** — Binary attachment data
- **`sync_queue`** — Pending outbound operations (flag changes, moves, deletes)
- **`sync_state`** — Per-account sync progress and health
- **`sync_audit`** — Append-only log of all sync events

## Testing

143 tests across 6 layers:

- **Unit** (85 tests, <1s) — UID parsing, change detection, MIME parsing, coalescing
- **PG Integration** (15 tests, ~30s) — triggers, NOTIFY, loop guard, crash recovery
- **IMAP Integration** (21 tests, ~3s) — connect, capabilities, folder discovery, IDLE
- **E2E** (17 tests, ~2min) — full bidirectional sync with real PG + Stalwart
- **Chaos** (2 tests, ~1min) — network partition and slow responses via Toxiproxy
- **Property** (3 tests, ~3min) — fast-check convergence, idempotency, loop-bounded

## Tech Stack

- **TypeScript** on Node.js 22+ LTS
- **ImapFlow** — production-proven IMAP client (powers EmailEngine)
- **postgres.js** + **pg-listen** — PG driver with LISTEN/NOTIFY
- **Kysely** — type-safe SQL query builder and migrations
- **mailparser** — RFC 2822/MIME parsing (same author as ImapFlow)
- **pino** — structured JSON logging
- **Stalwart** — test IMAP/SMTP server
- **Toxiproxy** — network fault injection for chaos tests

## License

[MIT](LICENSE) — Frederik Berg
