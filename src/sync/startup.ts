import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
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
}
