import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getDatabaseSsl, getDatabaseUrl, loadConfig } from "./config.js";
import { validateEncryptionKey } from "./crypto.js";
import { createDatabase } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { createHealthServer } from "./health.js";
import { Orchestrator } from "./sync/orchestrator.js";
import { startupRecovery } from "./sync/startup.js";
import { createLogger, setLogLevel } from "./util/logger.js";

/** package.json is the single source of truth for the service version. */
function readServiceVersion(): string {
  const pkgPath = path.join(import.meta.dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  return pkg.version;
}

const log = createLogger("main");

/**
 * Backstop for shutdown, not the primary fix -- AccountSync cancellation (see
 * account-sync.ts) is what makes orchestrator.stop() return promptly in the normal case.
 * This only guards the pathological case where a single IMAP command hangs with no
 * response at all (nothing to cancel into), so the process still exits well inside a
 * typical Kubernetes terminationGracePeriodSeconds instead of waiting for SIGKILL.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  const config = loadConfig();

  // config.yaml is the default; LOG_LEVEL stays available as an emergency override, and
  // since it already seeded the logger's initial level at import time, only apply
  // config's level when no override was set.
  if (!process.env.LOG_LEVEL) {
    setLogLevel(config.logging.level);
  }

  // Validate encryption key at startup if configured
  if (config.encryption_key) {
    validateEncryptionKey(config.encryption_key);
    log.info("Credential encryption enabled (AES-256-GCM)");
  } else {
    log.warn("No encryption key configured -- credentials stored as plaintext");
  }

  const databaseUrl = getDatabaseUrl(config);
  const ssl = getDatabaseSsl(config);
  const db = createDatabase(databaseUrl, ssl);

  // Run migrations
  await migrateUp(databaseUrl, ssl);

  // Publish the running service version through the contract-version handshake table
  await db
    .updateTable("postimap_info")
    .set({ service_version: readServiceVersion(), updated_at: new Date() })
    .where("singleton", "=", true)
    .execute();

  // Recover any sync_queue entries left in processing state from a previous crash
  await startupRecovery(db);

  // Create and start orchestrator
  const orchestrator = new Orchestrator(
    db,
    {
      SYNC_INTERVAL_SECONDS: config.sync.interval_seconds,
      IDLE_RESTART_SECONDS: config.sync.idle_restart_seconds,
      OUTBOUND_POLL_SECONDS: config.sync.outbound_poll_seconds,
      MAX_RETRY_ATTEMPTS: config.sync.max_retry_attempts,
      IMAP_TLS_REJECT_UNAUTHORIZED: config.imap.tls_reject_unauthorized,
      ENCRYPTION_KEY: config.encryption_key,
      IDLE_FOLDERS: config.sync.idle_folders,
      MAX_MESSAGE_BYTES: config.storage.max_message_bytes,
      RETENTION: {
        purgeExpungedAfterDays: config.retention.purge_expunged_after_days,
        purgeFoldersAfterDays: config.retention.purge_folders_after_days,
        auditDays: config.retention.audit_days,
        notificationsDays: config.retention.notifications_days,
      },
      RETENTION_INTERVAL_HOURS: config.retention.interval_hours,
    },
    databaseUrl,
  );

  // Start health server
  const healthServer = createHealthServer(orchestrator, db, config.health.port);

  // Start sync
  await orchestrator.start();

  log.info("PostIMAP started");

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down");

    const stopped = await Promise.race([
      orchestrator.stop().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (!stopped) {
      log.warn(
        { timeoutMs: SHUTDOWN_TIMEOUT_MS },
        "Orchestrator did not stop within the shutdown timeout, exiting anyway",
      );
    }

    healthServer.close();
    await db.destroy();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      log.fatal({ err }, "Shutdown error");
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      log.fatal({ err }, "Shutdown error");
      process.exit(1);
    });
  });
}

main().catch((err) => {
  const log = createLogger("main");
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
