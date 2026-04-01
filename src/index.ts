import { getDatabaseUrl, loadConfig } from "./config.js";
import { validateEncryptionKey } from "./crypto.js";
import { createDatabase } from "./db/connection.js";
import { migrateUp } from "./db/migrate.js";
import { createHealthServer } from "./health.js";
import { Orchestrator } from "./sync/orchestrator.js";
import { startupRecovery } from "./sync/startup.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const config = loadConfig();

  // Validate encryption key at startup if configured
  if (config.encryption_key) {
    validateEncryptionKey(config.encryption_key);
    log.info("Credential encryption enabled (AES-256-GCM)");
  } else {
    log.warn("No encryption key configured -- credentials stored as plaintext");
  }

  const databaseUrl = getDatabaseUrl(config);
  const db = createDatabase(databaseUrl);

  // Run migrations
  await migrateUp(databaseUrl);

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
    },
    databaseUrl,
  );

  // Start health server
  const healthServer = createHealthServer(orchestrator, config.health.port);

  // Start sync
  await orchestrator.start();

  log.info("PostIMAP started");

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down");
    await orchestrator.stop();
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
