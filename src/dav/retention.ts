import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { SyncAbortedError, throwIfAborted } from "../util/abort.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("dav-retention");
const BATCH_SIZE = 500;

export interface DavRetentionConfig {
  purgeDavObjectsAfterDays: number;
  purgeDavCollectionsAfterDays: number;
  auditDays: number;
  notificationsDays: number;
}

export interface DavPurgeResult {
  objectsDeleted: number;
  collectionsDeleted: number;
  queueDeleted: number;
  notificationsDeleted: number;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

/** Hard-deletes tombstoned DAV objects/collections and old queue/notification rows. */
export async function purgeDavExpired(
  db: Kysely<Database>,
  config: DavRetentionConfig,
  signal?: AbortSignal,
): Promise<DavPurgeResult> {
  const objectCutoff = daysAgo(config.purgeDavObjectsAfterDays);
  let objectsDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const rows = await db
      .selectFrom("dav_objects")
      .select("id")
      .where("deleted_at", "is not", null)
      .where("deleted_at", "<", objectCutoff)
      .limit(BATCH_SIZE)
      .execute();
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    await withSyncWriter(db, (trx) =>
      trx.deleteFrom("dav_objects").where("id", "in", ids).execute(),
    );
    objectsDeleted += ids.length;
    if (rows.length < BATCH_SIZE) break;
  }

  throwIfAborted(signal);

  const collectionCutoff = daysAgo(config.purgeDavCollectionsAfterDays);
  let collectionsDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const rows = await db
      .selectFrom("dav_collections")
      .select("id")
      .where("deleted_at", "is not", null)
      .where("deleted_at", "<", collectionCutoff)
      .limit(BATCH_SIZE)
      .execute();
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    // Every live object under a collection this old is gone from the server too --
    // cascades via the FK, the same way a hard-deleted IMAP folder takes its messages.
    await withSyncWriter(db, (trx) =>
      trx.deleteFrom("dav_collections").where("id", "in", ids).execute(),
    );
    collectionsDeleted += ids.length;
    if (rows.length < BATCH_SIZE) break;
  }

  throwIfAborted(signal);

  const auditCutoff = daysAgo(config.auditDays);
  let queueDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await db
      .deleteFrom("dav_sync_queue")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("dav_sync_queue")
          .select("id")
          .where("status", "in", ["completed", "dead"])
          .where("processed_at", "<", auditCutoff)
          .limit(BATCH_SIZE),
      )
      .executeTakeFirst();
    const count = Number(result.numDeletedRows ?? 0);
    queueDeleted += count;
    if (count < BATCH_SIZE) break;
  }

  throwIfAborted(signal);

  const notificationCutoff = daysAgo(config.notificationsDays);
  let notificationsDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await db
      .deleteFrom("dav_notifications")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("dav_notifications")
          .select("id")
          .where("acknowledged_at", "is not", null)
          .where("acknowledged_at", "<", notificationCutoff)
          .limit(BATCH_SIZE),
      )
      .executeTakeFirst();
    const count = Number(result.numDeletedRows ?? 0);
    notificationsDeleted += count;
    if (count < BATCH_SIZE) break;
  }

  const result: DavPurgeResult = {
    objectsDeleted,
    collectionsDeleted,
    queueDeleted,
    notificationsDeleted,
  };
  if (Object.values(result).some((n) => n > 0)) {
    log.info(result, "DAV retention purge complete");
  }
  return result;
}

/** Runs {@link purgeDavExpired} on a fixed interval, once immediately on start(). */
export class DavRetentionJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private abortController = new AbortController();
  private currentRun: Promise<void> | null = null;

  constructor(
    private db: Kysely<Database>,
    private config: DavRetentionConfig,
    private intervalMs: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.scheduleRun();
    this.timer = setInterval(() => this.scheduleRun(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abortController.abort();
    if (this.currentRun) {
      await this.currentRun.catch(() => {});
    }
  }

  private scheduleRun(): void {
    if (!this.running || this.currentRun) return;
    this.currentRun = purgeDavExpired(this.db, this.config, this.abortController.signal)
      .then(() => undefined)
      .catch((err) => {
        if (err instanceof SyncAbortedError) return;
        log.error({ err }, "DAV retention purge failed");
      })
      .finally(() => {
        this.currentRun = null;
      });
  }
}
