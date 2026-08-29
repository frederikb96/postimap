# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Node.js floor raised to 24 (LTS); Dockerfile base image, CI, and `@types/node` updated to match
- Dependency backlog taken across the board: `zod` 4, `pino` 10, `@biomejs/biome` 2, `testcontainers` / `@testcontainers/postgresql` 12, `@faker-js/faker` 10, `nodemailer` 9 (security), `typescript` 7, `kysely` 0.29, `kysely-postgres-js` 4, `toxiproxy-node-client` 4, plus routine minor/patch bumps across the rest
- `kysely`'s `Migrator`/`FileMigrationProvider` now imported from `kysely/migration` (moved off the main entry point in 0.29)
- `biome.json` migrated to the v2 config schema (`assist.actions.source.organizeImports`, `linter.rules.preset`, `files.includes`)
- Test containers: `postgres` image to 18-alpine (compose volumes now mount at `/var/lib/postgresql`, not `/var/lib/postgresql/data`, per the 18.x image layout change), `stalwartlabs/mail-server` to v0.11.8, `ghcr.io/shopify/toxiproxy` to 2.12.0
- Toxiproxy test container healthcheck removed -- the 2.12.0 image ships only the `toxiproxy` binary (no shell, no wget), so callers poll the HTTP API directly instead
- GitHub Actions bumped: `actions/checkout` 7, `actions/setup-node` 7 (Node 24), `docker/setup-buildx-action` 4, `docker/login-action` 4, `docker/metadata-action` 6, `docker/build-push-action` 7, `softprops/action-gh-release` 3
- `npm ci` now records `allowScripts` in `package.json` for the transitive native/postinstall dependencies (`esbuild`, `ssh2`, `cpu-features`, `protobufjs`) so installs are unambiguous under npm's install-script gating

### Added
- `renovate.json` custom regex manager tracking the container image strings in `tests/setup/global-setup.ts`
- Release workflow now fails if the pushed tag doesn't match `package.json`'s version

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
