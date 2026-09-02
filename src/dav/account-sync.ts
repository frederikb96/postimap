import type { Kysely } from "kysely";
import { decryptPassword } from "../crypto.js";
import { encryptStoredDavCredential } from "../db/credentials.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { SyncAbortedError, throwIfAborted } from "../util/abort.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import { DavClient } from "./client.js";
import { backfillCollection, fullReconcile, syncCollectionIncremental } from "./collection-sync.js";
import { discoverCollections, discoverHomes, reconcileCollections } from "./discovery.js";
import type { DavOutboundProcessor } from "./outbound.js";

const log = createLogger("dav-account-sync");

export type DavAccountState = "created" | "syncing" | "active" | "error" | "disabled";

const MAX_BACKOFF_MS = 300_000;
const BASE_BACKOFF_MS = 2_000;

export interface DavAccountSyncConfig {
  POLL_SECONDS: number;
  FULL_RECONCILE_SECONDS: number;
  TLS_REJECT_UNAUTHORIZED: boolean;
  REQUEST_TIMEOUT_SECONDS: number;
  MULTIGET_CHUNK: number;
  ENCRYPTION_KEY?: string;
}

interface DavAccountRow {
  id: string;
  url: string;
  username: string;
  password: Buffer;
  is_active: boolean;
}

interface DbCollectionRow {
  id: string;
  account_id: string;
  href: string | null;
  kind: string;
  sync_tier: string | null;
  initial_sync_done: boolean;
  last_full_reconcile_at: Date | null;
}

/**
 * Per-account DAV sync lifecycle. Shaped like `sync/account-sync.ts` -- state machine,
 * abort-and-await-current-run shutdown, retry backoff -- without reusing that class, since
 * there is no IMAP connection, IDLE watcher, or QRESYNC/CONDSTORE tier to carry.
 */
export class DavAccountSync {
  private state: DavAccountState = "created";
  private client: DavClient | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private stopped = false;
  private syncing = false;
  private abortController = new AbortController();
  private currentRun: Promise<void> | null = null;

  constructor(
    private accountId: string,
    private db: Kysely<Database>,
    private config: DavAccountSyncConfig,
    private outboundProcessor: DavOutboundProcessor,
  ) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    const run = this.runStart();
    this.currentRun = run;
    try {
      await run;
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  private async runStart(): Promise<void> {
    const signal = this.abortController.signal;
    try {
      await this.transitionState("syncing");

      const account = await this.getAccountRow();
      if (!account?.is_active) {
        await this.transitionState("disabled");
        return;
      }

      const reEncrypted = await encryptStoredDavCredential(
        this.db,
        this.accountId,
        this.config.ENCRYPTION_KEY,
      );
      if (reEncrypted) {
        log.info({ accountId: this.accountId }, "Encrypted plaintext DAV credentials at rest");
      }

      this.client = new DavClient({
        baseUrl: account.url,
        username: account.username,
        password: decryptPassword(account.password, this.config.ENCRYPTION_KEY),
        tlsRejectUnauthorized: this.config.TLS_REJECT_UNAUTHORIZED,
        requestTimeoutMs: this.config.REQUEST_TIMEOUT_SECONDS * 1_000,
      });

      const homes = await discoverHomes(this.client);
      throwIfAborted(signal);
      if (!homes.principalUrl) {
        throw new Error("Could not discover current-user-principal");
      }

      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("dav_accounts")
          .set({
            principal_url: homes.principalUrl,
            calendar_home_url: homes.calendarHomeUrl,
            addressbook_home_url: homes.addressbookHomeUrl,
          })
          .where("id", "=", this.accountId)
          .execute(),
      );

      await this.discoverAndReconcile(homes.calendarHomeUrl, homes.addressbookHomeUrl);
      throwIfAborted(signal);

      const client = this.client;
      const collections = await this.getDbCollections();
      for (const collection of collections) {
        throwIfAborted(signal);
        if (collection.initial_sync_done) continue;
        await this.runCollection(collection, () =>
          backfillCollection(this.db, client, collection, this.config.MULTIGET_CHUNK),
        );
      }

      await this.outboundProcessor.subscribeAccount(this.accountId);

      this.startPeriodicSync();
      this.retryAttempt = 0;
      await this.transitionState("active");

      log.info(
        { accountId: this.accountId, collections: collections.length },
        "DAV account sync started",
      );
    } catch (err) {
      if (err instanceof SyncAbortedError) {
        log.info({ accountId: this.accountId }, "DAV account sync start aborted (shutdown)");
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId: this.accountId }, "DAV account sync startup failed");
      await this.transitionState("error", errMsg);
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    if (this.currentRun) {
      await this.currentRun.catch(() => {});
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    await this.outboundProcessor.unsubscribeAccount(this.accountId).catch((err) => {
      log.warn({ err, accountId: this.accountId }, "Error unsubscribing DAV outbound");
    });

    this.client = null;

    if (this.state !== "error") {
      await this.transitionState("disabled");
    }
    log.info({ accountId: this.accountId }, "DAV account sync stopped");
  }

  getState(): DavAccountState {
    return this.state;
  }

  /** Provide the DavClient for this account (used by the orchestrator for outbound routing). */
  getClient(): DavClient | null {
    return this.client;
  }

  async requestSync(): Promise<void> {
    return this.periodicSync();
  }

  private async periodicSync(): Promise<void> {
    if (this.stopped || this.syncing || this.state !== "active") return;
    const run = this.runPeriodicSync();
    this.currentRun = run;
    try {
      await run;
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  private async runPeriodicSync(): Promise<void> {
    const signal = this.abortController.signal;
    this.syncing = true;
    try {
      const client = this.client;
      if (!client) return;

      const account = await this.getAccountRow();
      if (!account) return;

      const stored = await this.db
        .selectFrom("dav_accounts")
        .select(["calendar_home_url", "addressbook_home_url"])
        .where("id", "=", this.accountId)
        .executeTakeFirst();

      await this.discoverAndReconcile(
        stored?.calendar_home_url ?? null,
        stored?.addressbook_home_url ?? null,
      );
      throwIfAborted(signal);

      const now = Date.now();
      const reconcileAgeMs = this.config.FULL_RECONCILE_SECONDS * 1_000;
      const collections = await this.getDbCollections();

      for (const collection of collections) {
        throwIfAborted(signal);

        if (!collection.initial_sync_done) {
          await this.runCollection(collection, () =>
            backfillCollection(this.db, client, collection, this.config.MULTIGET_CHUNK),
          );
          continue;
        }

        const dueForFullReconcile =
          !collection.last_full_reconcile_at ||
          now - collection.last_full_reconcile_at.getTime() >= reconcileAgeMs;

        if (dueForFullReconcile) {
          await this.runCollection(collection, () => fullReconcile(this.db, client, collection));
        } else {
          await this.runCollection(collection, () =>
            syncCollectionIncremental(this.db, client, collection),
          );
        }
      }
    } catch (err) {
      if (err instanceof SyncAbortedError) {
        log.info({ accountId: this.accountId }, "Periodic DAV sync aborted (shutdown)");
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId: this.accountId }, "Periodic DAV sync failed");
      await this.transitionState("error", errMsg);
      this.scheduleRetry();
    } finally {
      this.syncing = false;
    }
  }

  private async runCollection(
    collection: DbCollectionRow,
    fn: () => Promise<{ upserted: number; tombstoned: number; errors: number }>,
  ): Promise<void> {
    try {
      const result = await fn();
      if (result.errors > 0 || result.upserted > 0 || result.tombstoned > 0) {
        log.info({ collectionId: collection.id, ...result }, "DAV collection sync cycle complete");
      }
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("dav_collections")
          .set({ sync_error: null })
          .where("id", "=", collection.id)
          .execute(),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, collectionId: collection.id }, "DAV collection sync failed");
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("dav_collections")
          .set({ sync_error: errMsg })
          .where("id", "=", collection.id)
          .execute(),
      );
    }
  }

  private async discoverAndReconcile(
    calendarHomeUrl: string | null,
    addressbookHomeUrl: string | null,
  ): Promise<void> {
    if (!this.client) return;
    const discovered = [];
    if (calendarHomeUrl) {
      discovered.push(...(await discoverCollections(this.client, calendarHomeUrl, "calendar")));
    }
    if (addressbookHomeUrl) {
      discovered.push(
        ...(await discoverCollections(this.client, addressbookHomeUrl, "addressbook")),
      );
    }
    await reconcileCollections(this.db, this.accountId, discovered);
  }

  private startPeriodicSync(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = setInterval(() => {
      this.periodicSync().catch((err) => {
        log.error({ err, accountId: this.accountId }, "Periodic DAV sync scheduling error");
      });
    }, this.config.POLL_SECONDS * 1_000);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = computeDelay(this.retryAttempt, {
      maxRetries: Number.MAX_SAFE_INTEGER,
      baseDelay: BASE_BACKOFF_MS,
      maxDelay: MAX_BACKOFF_MS,
      jitter: true,
    });
    this.retryAttempt++;
    log.info(
      { accountId: this.accountId, attempt: this.retryAttempt, delayMs: Math.round(delay) },
      "Scheduling DAV retry",
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.start().catch((err) => {
        log.error({ err, accountId: this.accountId }, "DAV retry failed");
      });
    }, delay);
  }

  private async transitionState(newState: DavAccountState, errorMsg?: string): Promise<void> {
    this.state = newState;
    try {
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("dav_accounts")
          .set({ state: newState, state_error: newState === "error" ? (errorMsg ?? null) : null })
          .where("id", "=", this.accountId)
          .execute(),
      );
    } catch (err) {
      log.error(
        { err, accountId: this.accountId },
        "Failed to persist DAV account state transition",
      );
    }
  }

  private async getAccountRow(): Promise<DavAccountRow | null> {
    const row = await this.db
      .selectFrom("dav_accounts")
      .select(["id", "url", "username", "password", "is_active"])
      .where("id", "=", this.accountId)
      .executeTakeFirst();
    return row ?? null;
  }

  private async getDbCollections(): Promise<DbCollectionRow[]> {
    return this.db
      .selectFrom("dav_collections")
      .select([
        "id",
        "account_id",
        "href",
        "kind",
        "sync_tier",
        "initial_sync_done",
        "last_full_reconcile_at",
      ])
      .where("account_id", "=", this.accountId)
      .where("deleted_at", "is", null)
      .where("href", "is not", null)
      .execute();
  }
}
