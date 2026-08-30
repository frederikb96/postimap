import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { SyncAbortedError, throwIfAborted } from "../util/abort.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("retention");

/** Rows are deleted in bounded batches so a single purge stays interruptible mid-run. */
const BATCH_SIZE = 500;

export interface RetentionConfig {
  purgeExpungedAfterDays: number;
  purgeFoldersAfterDays: number;
  auditDays: number;
  notificationsDays: number;
}

export interface PurgeResult {
  messagesDeleted: number;
  foldersDeleted: number;
  queueDeleted: number;
  auditDeleted: number;
  notificationsDeleted: number;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

/**
 * Deletes rows matching `selectIds` in batches of {@link BATCH_SIZE}, checking `signal`
 * between batches. Used for tables with no natural per-row cost bound (an account that
 * has accumulated years of expunged mail can have far more rows than fit comfortably in
 * one transaction) and for the two tables (`messages`, `folders`) whose triggers need the
 * `postimap.writer` GUC set so their `postimap_events` deletes report `origin: "sync"`.
 */
async function purgeBatched(
  db: Kysely<Database>,
  table: "messages" | "folders",
  selectIds: (conn: Kysely<Database>) => Promise<{ id: string }[]>,
  deleteByIds: (trx: Kysely<Database>, ids: string[]) => Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  while (true) {
    throwIfAborted(signal);
    const rows = await selectIds(db);
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    await withSyncWriter(db, (trx) => deleteByIds(trx, ids));
    total += ids.length;

    log.debug({ table, batch: ids.length, total }, "Purge batch complete");
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

/**
 * Hard-deletes expunged messages, long-tombstoned folders, and old operational log rows
 * (`sync_queue`, `sync_audit`) that have accumulated past their configured retention
 * window -- none of these are ever purged anywhere else, so without this job the mirror
 * grows forever. Interruptible between batches via `signal`, same contract as
 * `fetchAndStoreMessages` in message-sync.ts.
 */
export async function purgeExpired(
  db: Kysely<Database>,
  config: RetentionConfig,
  signal?: AbortSignal,
): Promise<PurgeResult> {
  const expungedCutoff = daysAgo(config.purgeExpungedAfterDays);
  const messagesDeleted = await purgeBatched(
    db,
    "messages",
    (conn) =>
      conn
        .selectFrom("messages")
        .select("id")
        .where("expunged_at", "is not", null)
        .where("expunged_at", "<", expungedCutoff)
        .limit(BATCH_SIZE)
        .execute(),
    (trx, ids) =>
      trx
        .deleteFrom("messages")
        .where("id", "in", ids)
        .execute()
        .then(() => undefined),
    signal,
  );

  throwIfAborted(signal);

  // Only folders absent from the server long enough that a flaky/partial LIST reappearing
  // them is no longer a plausible explanation -- folder-sync.ts un-tombstones a folder
  // that reappears at any point before this.
  const folderCutoff = daysAgo(config.purgeFoldersAfterDays);
  // Messages still attached to a folder about to be hard-deleted go with it via the FK
  // cascade, without passing through the messages purge above. Counting them here is what
  // keeps the returned total a count of rows actually destroyed rather than of rows this
  // function deleted by id.
  const cascaded = await db
    .selectFrom("messages")
    .innerJoin("folders", "folders.id", "messages.folder_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("folders.deleted_at", "is not", null)
    .where("folders.deleted_at", "<", folderCutoff)
    .executeTakeFirst();
  const cascadedMessages = Number(cascaded?.n ?? 0);

  const foldersDeleted = await purgeBatched(
    db,
    "folders",
    (conn) =>
      conn
        .selectFrom("folders")
        .select("id")
        .where("deleted_at", "is not", null)
        .where("deleted_at", "<", folderCutoff)
        .limit(BATCH_SIZE)
        .execute(),
    (trx, ids) =>
      trx
        .deleteFrom("folders")
        .where("id", "in", ids)
        .execute()
        .then(() => undefined),
    signal,
  );

  throwIfAborted(signal);

  // sync_queue/sync_audit are internal bookkeeping, not part of the consumer contract --
  // no postimap_events trigger reacts to their deletion, so a plain (non-writer) delete
  // is enough.
  const auditCutoff = daysAgo(config.auditDays);
  let queueDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await db
      .deleteFrom("sync_queue")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("sync_queue")
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

  let auditDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await db
      .deleteFrom("sync_audit")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("sync_audit")
          .select("id")
          .where("created_at", "<", auditCutoff)
          .limit(BATCH_SIZE),
      )
      .executeTakeFirst();
    const count = Number(result.numDeletedRows ?? 0);
    auditDeleted += count;
    if (count < BATCH_SIZE) break;
  }

  throwIfAborted(signal);

  // Keyed on acknowledged_at, never created_at. An unacknowledged notification is the only
  // record a consumer has that one of its writes never landed, so age alone must not be
  // able to destroy it -- however long it sits there. Growth stays bounded because a row is
  // written once per operation that reaches a terminal failure, not once per retry.
  const notificationCutoff = daysAgo(config.notificationsDays);
  let notificationsDeleted = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await db
      .deleteFrom("sync_notifications")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("sync_notifications")
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

  const result: PurgeResult = {
    messagesDeleted: messagesDeleted + cascadedMessages,
    foldersDeleted,
    queueDeleted,
    auditDeleted,
    notificationsDeleted,
  };
  if (Object.values(result).some((n) => n > 0)) {
    log.info(result, "Retention purge complete");
  }
  return result;
}

/**
 * Runs {@link purgeExpired} on a fixed interval, once immediately on start(). A single
 * global job, not per-account -- retention windows apply mirror-wide.
 */
export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private abortController = new AbortController();
  private currentRun: Promise<void> | null = null;

  constructor(
    private db: Kysely<Database>,
    private config: RetentionConfig,
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

    this.currentRun = purgeExpired(this.db, this.config, this.abortController.signal)
      .then(() => undefined)
      .catch((err) => {
        if (err instanceof SyncAbortedError) return;
        log.error({ err }, "Retention purge failed");
      })
      .finally(() => {
        this.currentRun = null;
      });
  }
}
