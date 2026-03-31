# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Configuration migrated from flat env vars to YAML-based loader with three-layer merge (default YAML, custom override, env vars)
- `config/config.yaml` is now the single source of truth for all config defaults
- Database connection composed from individual fields (host, port, name, user, password) instead of single `DATABASE_URL`
- Added `yaml` dependency for YAML config parsing

### Added
- `config/config.yaml` -- default configuration with comments
- `config-custom/` directory for deployment-specific overrides
- `compose.yaml` -- production compose file
- `compose.dev.yaml` -- development compose file with local build and Stalwart
- `.dev.env.example` / `.prod.env.example` -- secret env file templates
- `POSTIMAP_*` env var overrides for any config value (e.g., `POSTIMAP_DATABASE_HOST`)
- `CONFIG_OVERRIDE_PATH` env var to customize override file location
- `getDatabaseUrl()` helper to compose connection string from config parts

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
- Comprehensive test suite: 143 tests across 6 layers (unit, PG integration, IMAP integration, E2E, chaos, property)
- Toxiproxy-based chaos testing (network partition, slow responses)
- fast-check property testing (convergence, idempotency, loop-bounded)
- Dual-mode test containers (compose for local, testcontainers for CI)
- GitHub Actions CI pipeline with parallel test execution
- Dockerfile with multi-stage build
- Renovate for automated dependency updates
