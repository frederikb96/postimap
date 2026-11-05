# Development

## Running the tests

```bash
npm install
npm run test:unit         # fast, no containers needed
npm test                  # full suite -- spins up PG, Dovecot, Mailpit, Radicale and Toxiproxy via testcontainers
```

Tests need a container runtime reachable as Docker (Docker itself, or rootless Podman with
`systemctl --user enable --now podman.socket`) — nothing else to start by hand. `npm run lint`
and `npm run typecheck` cover the rest; each test layer has its own script in `package.json`.

## Test layers

Seven layers, fastest first:

- **Unit** — UID parsing, change detection (including the QRESYNC/CONDSTORE tiers, mocked), MIME
  parsing, coalescing. No containers.
- **PG Integration** — triggers, NOTIFY, loop guard, crash recovery
- **IMAP Integration** — connect, capabilities (asserts the test server genuinely advertises
  CONDSTORE/QRESYNC), folder discovery, IDLE
- **DAV Integration** — discovery, `sync-collection` with inline data, `MOVE`, conditional `PUT`
  against a real Radicale (hard assertions, never a skip)
- **E2E** — full bidirectional sync with real PG + Dovecot, and with real PG + Radicale for the DAV
  side
- **Chaos** — network partition and slow responses via Toxiproxy
- **Property** — fast-check convergence, idempotency, loop-bounded

CI runs everything except Chaos and Property on every pull request; those two run nightly and on
release tags (see `.github/workflows/`) since they're slow and don't gate merges.

## Tech stack

- **TypeScript** on Node.js 26+ LTS
- **ImapFlow** — production-proven IMAP client (powers EmailEngine)
- **postgres.js** + **pg-listen** — PG driver with LISTEN/NOTIFY
- **Kysely** — type-safe SQL query builder and migrations
- **mailparser** — RFC 2822/MIME parsing, and **nodemailer** to compose outgoing mail (same author
  as ImapFlow)
- **pino** — structured JSON logging
- **tsdav** — WebDAV/CalDAV/CardDAV requests and multistatus parsing, and **ical.js** to parse
  iCalendar and vCard
- **Dovecot** — test IMAP server · **Mailpit** — test SMTP server · **Radicale** — test
  CalDAV/CardDAV server
- **Toxiproxy** — network fault injection for chaos tests
