import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("startup");

export async function startupRecovery(db: Kysely<Database>): Promise<void> {
  // Reset entries that were mid-flight when the process crashed
  const result = await db
    .updateTable("sync_queue")
    .set({ status: "pending", error: "Reset on startup (process restart)" })
    .where("status", "=", "processing")
    .executeTakeFirst();

  log.info({ resetCount: result.numUpdatedRows }, "Startup recovery: reset processing entries");

  // Same for outbox rows -- a crash between claim and completion must not strand a send
  // or draft in 'processing' forever. Tagged as a sync-engine write so the resulting
  // postimap_events outbox/update carries origin: "sync", not "app".
  const outboxResult = await withSyncWriter(db, (trx) =>
    trx
      .updateTable("outbox")
      .set({ status: "pending", error: "Reset on startup (process restart)" })
      .where("status", "=", "processing")
      .executeTakeFirst(),
  );

  log.info(
    { resetCount: outboxResult.numUpdatedRows },
    "Startup recovery: reset processing outbox entries",
  );
}
