import type { Kysely } from "kysely";
import { decryptPassword } from "../crypto.js";
import { encryptStoredCredentials } from "../db/credentials.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import {
  cacheCapabilities,
  detectCapabilities,
  type ServerCapabilities,
  selectSyncTier,
} from "../imap/capabilities.js";
import { ImapClient } from "../imap/pool.js";
import { discoverFolders, type FolderInfo, syncFoldersToPg } from "../protocol/folder-sync.js";
import { SyncAbortedError, throwIfAborted } from "../util/abort.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import { IdleWatcher, type IdleWatcherConfig } from "./idle-watcher.js";
import { InboundSync } from "./inbound.js";
import type { OutboundProcessor } from "./outbound.js";
import type { OutboxProcessor } from "./outbox.js";
import { updateSyncState } from "./sync-state.js";

const log = createLogger("account-sync");

export type AccountState = "created" | "syncing" | "active" | "error" | "disabled";

const MAX_BACKOFF_MS = 300_000;
const BASE_BACKOFF_MS = 2_000;

interface AccountRow {
  id: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password: Buffer;
  is_active: boolean;
}

export class AccountSync {
  private state: AccountState = "created";
  private imapClient: ImapClient | null = null;
  private capabilities: ServerCapabilities | null = null;
  private idleWatcher: IdleWatcher | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private stopped = false;
  private syncing = false;
  /**
   * Cancels an in-flight start() or periodicSync() so stop() can return promptly instead
   * of waiting out a full-folder sync that can run tens of seconds. Only ever aborted by
   * stop() itself -- retries reuse this same instance and must not be cut short.
   */
  private abortController = new AbortController();
  /**
   * The currently in-flight start() or periodicSync() call, if any. stop() awaits this
   * after aborting so the IMAP connection is only torn down once the aborted run has
   * actually observed the signal and returned -- disconnecting underneath a still-running
   * fetch loop would race the socket close against whatever command is in flight.
   */
  private currentRun: Promise<void> | null = null;

  constructor(
    private accountId: string,
    private db: Kysely<Database>,
    private config: {
      SYNC_INTERVAL_SECONDS: number;
      IDLE_RESTART_SECONDS: number;
      IMAP_TLS_REJECT_UNAUTHORIZED: boolean;
      ENCRYPTION_KEY?: string;
      /**
       * Folder names watched via IDLE. Each one opens its own dedicated IMAP connection
       * (a protocol limitation -- IDLE occupies the whole connection), so this is what
       * keeps a many-folder account from opening one connection per folder against a
       * server that caps concurrent connections per account.
       */
      IDLE_FOLDERS: string[];
      /** Above this size a message is stored as envelope+flags only; see message-sync.ts. */
      MAX_MESSAGE_BYTES?: number;
      FULL_TIER_MAX_SKIP_SECONDS: number;
    },
    _databaseUrl: string,
    private outboundProcessor: OutboundProcessor,
    private outboxProcessor: OutboxProcessor,
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

      // Read account credentials from PG
      const account = await this.getAccountRow();
      if (!account?.is_active) {
        await this.transitionState("disabled");
        return;
      }

      // Bring credentials up to the configured encryption format. The row already read
      // stays valid either way -- the format byte is authoritative on read.
      const reEncrypted = await encryptStoredCredentials(
        this.db,
        this.accountId,
        this.config.ENCRYPTION_KEY,
      );
      if (reEncrypted.length > 0) {
        log.info(
          { accountId: this.accountId, columns: reEncrypted },
          "Encrypted plaintext credentials at rest",
        );
      }

      // Create IMAP client and connect
      this.imapClient = new ImapClient({
        host: account.imap_host,
        port: account.imap_port,
        user: account.imap_user,
        password: decryptPassword(account.imap_password, this.config.ENCRYPTION_KEY),
        tls: { rejectUnauthorized: this.config.IMAP_TLS_REJECT_UNAUTHORIZED },
      });

      await this.imapClient.connect();
      throwIfAborted(signal);

      // Detect and cache capabilities
      this.capabilities = detectCapabilities(this.imapClient.client);
      await cacheCapabilities(this.db, this.accountId, this.capabilities);

      // Discover and sync folders
      const remoteFolders = await this.discoverAndSyncFolders();
      throwIfAborted(signal);

      // Full sync all folders. Each folder is checked against the abort signal both
      // here and inside fullSync itself, so a shutdown mid-folder or between folders
      // stops promptly instead of running the whole backlog to completion.
      const inbound = new InboundSync(
        this.imapClient,
        this.db,
        this.accountId,
        this.capabilities,
        this.config.MAX_MESSAGE_BYTES,
        this.config.FULL_TIER_MAX_SKIP_SECONDS * 1_000,
      );

      const folders = await this.getDbFolders();
      const tier = selectSyncTier(this.capabilities);
      let totalMessages = 0;
      let totalErrors = 0;
      let foldersSynced = 0;

      for (const folder of folders) {
        throwIfAborted(signal);
        // Only a folder that has never completed its first sync gets backfill mode.
        // Running every folder through it unconditionally on every start suppresses
        // per-message insert events for mail already mirrored -- backfill is what
        // silences those events, and initial_sync_done is already true so no
        // sync_complete fires either, so a restart would mirror whatever arrived while
        // PostIMAP was down with no event of any kind reaching the consumer.
        const result = await inbound.fullSync(
          folder.id,
          folder.imap_name,
          !folder.initial_sync_done,
          signal,
        );
        totalMessages += result.newMessages;
        totalErrors += result.errors.length;
        foldersSynced++;
        if (result.connectionLost) {
          throw new Error(`IMAP connection lost during initial sync of folder ${folder.imap_name}`);
        }
        // Per folder, not once at the end. An initial backfill can run for hours, and
        // sync_state is the SQL-native way an operator watches it -- updated only after the
        // whole loop, it shows nothing moving at all for the entire run.
        await updateSyncState(this.db, this.accountId, {
          syncTier: tier,
          foldersSynced,
          foldersTotal: folders.length,
          messagesSynced: BigInt(totalMessages),
          errorCount: totalErrors,
          lastError: null,
          isIncremental: false,
        });
      }

      // Subscribe outbound and outbox processors for this account
      await this.outboundProcessor.subscribeAccount(this.accountId);
      await this.outboxProcessor.subscribeAccount(this.accountId);

      // Start IDLE watcher for folders with IDLE support
      if (this.capabilities.idle && remoteFolders.length > 0) {
        await this.startIdleWatcher(account);
      }
      // Unconditional: a server without IDLE still owes every folder a seeded preference
      // and an honest status. Gating this on the watcher existing left `idle_folders`
      // silently ignored forever on such an account, and every folder stuck on 'off' --
      // indistinguishable from a consumer who turned everything off deliberately.
      await this.refreshIdleFolders(remoteFolders);

      // Start periodic incremental sync
      this.startPeriodicSync();

      // Reset retry counter on success
      this.retryAttempt = 0;
      await this.transitionState("active");

      log.info(
        {
          accountId: this.accountId,
          folders: folders.length,
          messages: totalMessages,
          tier,
        },
        "Account sync started successfully",
      );
    } catch (err) {
      if (err instanceof SyncAbortedError) {
        // stop() is already in progress and owns the final state transition -- a
        // cancelled start is not a failure worth an error state or a retry.
        log.info({ accountId: this.accountId }, "Account sync start aborted (shutdown)");
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId: this.accountId }, "Account sync startup failed");

      await updateSyncState(this.db, this.accountId, {
        errorCount: this.retryAttempt + 1,
        lastError: errMsg,
      });

      await this.transitionState("error", errMsg);
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Cancel any in-flight start()/periodicSync() first, before the cleanup below --
    // otherwise a large folder's fetch loop keeps running for as long as it takes to
    // fetch everything, and stop() can't return until it does.
    this.abortController.abort();

    // Wait for the aborted run to actually observe the signal and return before tearing
    // down the IMAP connection below -- disconnecting underneath a run that is still
    // mid-command would race the socket close against whatever IMAP call is in flight.
    // Bounded by how long it takes the current single IMAP round-trip to finish, not by
    // the size of the folder or the number of folders left in the cycle.
    if (this.currentRun) {
      await this.currentRun.catch(() => {});
    }

    // Clear retry timer
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // Stop periodic sync
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    // Stop IDLE watcher
    if (this.idleWatcher) {
      await this.idleWatcher.stop().catch((err) => {
        log.warn({ err, accountId: this.accountId }, "Error stopping IDLE watcher");
      });
      this.idleWatcher = null;
    }

    // Unsubscribe outbound and outbox processors
    await this.outboundProcessor.unsubscribeAccount(this.accountId).catch((err) => {
      log.warn({ err, accountId: this.accountId }, "Error unsubscribing outbound");
    });
    await this.outboxProcessor.unsubscribeAccount(this.accountId).catch((err) => {
      log.warn({ err, accountId: this.accountId }, "Error unsubscribing outbox");
    });

    // Disconnect IMAP
    if (this.imapClient) {
      await this.imapClient.disconnect().catch((err) => {
        log.warn({ err, accountId: this.accountId }, "Error disconnecting IMAP");
      });
      this.imapClient = null;
    }

    this.capabilities = null;

    // Only transition to disabled if we were explicitly stopped
    if (this.state !== "error") {
      await this.transitionState("disabled");
    }

    log.info({ accountId: this.accountId }, "Account sync stopped");
  }

  getState(): AccountState {
    return this.state;
  }

  getAccountId(): string {
    return this.accountId;
  }

  /** Provide the ImapClient for this account (used by orchestrator for outbound routing) */
  getImapClient(): ImapClient | null {
    return this.imapClient;
  }

  /** Provide capabilities for this account */
  getCapabilities(): ServerCapabilities | null {
    return this.capabilities;
  }

  /** Number of IDLE-dedicated IMAP connections currently open, bounded by sync.idle_folders. */
  getIdleFolderCount(): number {
    return this.idleWatcher?.watchedFolderCount ?? 0;
  }

  /** Trigger an immediate sync. Called by periodic timer and external commands. */
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
      if (!this.imapClient || !this.capabilities) return;

      const inbound = new InboundSync(
        this.imapClient,
        this.db,
        this.accountId,
        this.capabilities,
        this.config.MAX_MESSAGE_BYTES,
        this.config.FULL_TIER_MAX_SKIP_SECONDS * 1_000,
      );

      // Reconcile the folder list every cycle: a folder created in another mail client
      // is only visible once the server is asked what exists, and the cycle below reads
      // its folders from PG.
      const remoteFolders = await this.discoverAndSyncFolders();
      throwIfAborted(signal);

      // A consumer's push request is an ordinary column write, so it takes effect on the
      // next cycle rather than needing a restart -- and a folder that has since gone from
      // the server stops being watched the same way.
      await this.refreshIdleFolders(remoteFolders);
      throwIfAborted(signal);

      const folders = await this.getDbFolders();
      let totalNew = 0;
      let totalUpdated = 0;
      let totalDeleted = 0;
      let totalErrors = 0;
      let foldersSynced = 0;

      for (const folder of folders) {
        throwIfAborted(signal);
        // A folder discovered on this cycle has no messages mirrored yet. Incremental
        // detection would treat that emptiness as the folder's state and never set
        // initial_sync_done, so the consumer would never see its sync_complete event.
        const result = folder.initial_sync_done
          ? await inbound.syncFolder(folder.id, folder.imap_name, signal)
          : await inbound.fullSync(folder.id, folder.imap_name, true, signal);
        totalNew += result.newMessages;
        totalUpdated += result.updatedFlags;
        totalDeleted += result.deletedMessages;
        totalErrors += result.errors.length;
        foldersSynced++;
        if (result.connectionLost) {
          throw new Error(`IMAP connection lost during sync of folder ${folder.imap_name}`);
        }
        await updateSyncState(this.db, this.accountId, {
          foldersSynced,
          foldersTotal: folders.length,
          messagesSynced: BigInt(totalNew),
          errorCount: totalErrors,
          lastError: totalErrors > 0 ? "Some folders had sync errors" : null,
          isIncremental: true,
        });
      }

      if (totalNew > 0 || totalUpdated > 0 || totalDeleted > 0) {
        log.info(
          {
            accountId: this.accountId,
            newMessages: totalNew,
            updatedFlags: totalUpdated,
            deletedMessages: totalDeleted,
          },
          "Periodic sync complete",
        );
      }
    } catch (err) {
      if (err instanceof SyncAbortedError) {
        log.info({ accountId: this.accountId }, "Periodic sync aborted (shutdown)");
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, accountId: this.accountId }, "Periodic sync failed");

      await updateSyncState(this.db, this.accountId, {
        errorCount: this.retryAttempt + 1,
        lastError: errMsg,
      });

      // Transition to error state on runtime failure
      await this.transitionState("error", errMsg);
      await this.cleanupForRetry();
      this.scheduleRetry();
    } finally {
      this.syncing = false;
    }
  }

  private startPeriodicSync(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
    }

    this.periodicTimer = setInterval(() => {
      this.periodicSync().catch((err) => {
        log.error({ err, accountId: this.accountId }, "Periodic sync scheduling error");
      });
    }, this.config.SYNC_INTERVAL_SECONDS * 1_000);
  }

  private async startIdleWatcher(account: AccountRow): Promise<void> {
    const idleConfig: IdleWatcherConfig = {
      host: account.imap_host,
      port: account.imap_port,
      user: account.imap_user,
      password: decryptPassword(account.imap_password, this.config.ENCRYPTION_KEY),
      tls: { rejectUnauthorized: this.config.IMAP_TLS_REJECT_UNAUTHORIZED },
    };

    // Each watched folder holds open its own dedicated IMAP connection -- IDLE occupies the
    // whole connection, so there is no way to share one across folders -- and providers cap
    // concurrent connections per account well below the number of folders a real account
    // has. Which folders are worth that budget is a per-account choice, so it lives on the
    // rows rather than in config, and refreshIdleFolders() fills the set in.
    this.idleWatcher = new IdleWatcher(
      idleConfig,
      [],
      async (folder) => {
        // On IDLE notification, trigger an incremental sync for the folder
        if (this.stopped || !this.imapClient || !this.capabilities) return;
        if (this.syncing) return;

        try {
          const dbFolder = await this.db
            .selectFrom("folders")
            .select(["id", "imap_name"])
            .where("account_id", "=", this.accountId)
            .where("imap_name", "=", folder)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (!dbFolder) return;

          const inbound = new InboundSync(
            this.imapClient,
            this.db,
            this.accountId,
            this.capabilities,
            this.config.MAX_MESSAGE_BYTES,
            this.config.FULL_TIER_MAX_SKIP_SECONDS * 1_000,
          );

          await inbound.syncFolder(dbFolder.id, dbFolder.imap_name, this.abortController.signal);
        } catch (err) {
          if (err instanceof SyncAbortedError) return;
          log.error({ err, accountId: this.accountId, folder }, "IDLE-triggered sync failed");
        }
      },
      this.config.IDLE_RESTART_SECONDS * 1_000,
      (folder, error) => this.reportAbandonedIdle(folder, error),
    );

    await this.idleWatcher.start();
  }

  /**
   * Which folders to watch, and the one moment `sync.idle_folders` still has a say.
   *
   * A folder whose `idle_status` is NULL has never been considered, so the configured
   * default seeds its `idle_requested` -- once. After that the column is the answer, which
   * is what keeps a consumer switching every folder off from being read as "expressed no
   * preference" and silently re-seeded from config on the next start.
   */
  private async resolveIdleFolders(remoteFolders: FolderInfo[]): Promise<string[]> {
    const defaults = this.config.IDLE_FOLDERS;
    if (defaults.length > 0) {
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("folders")
          .set({ idle_requested: true })
          .where("account_id", "=", this.accountId)
          .where("idle_status", "is", null)
          .where("imap_name", "in", defaults)
          .execute(),
      );
    }

    const requested = await this.db
      .selectFrom("folders")
      .select("imap_name")
      .where("account_id", "=", this.accountId)
      .where("deleted_at", "is", null)
      .where("idle_requested", "=", true)
      .execute();

    const remoteNames = new Set(remoteFolders.map((f) => f.imapName));
    return requested.map((r) => r.imap_name).filter((name) => remoteNames.has(name));
  }

  /**
   * Record what actually happened to each folder's request.
   *
   * `idle_status` is never left NULL after this runs: a folder nobody asked to watch says
   * 'off', so "not considered yet" stays distinguishable from "considered and declined".
   */
  private async writeIdleStatus(): Promise<void> {
    const watching = new Set(this.idleWatcher?.watchedFolders ?? []);
    const supported = this.capabilities?.idle ?? false;

    const folders = await this.db
      .selectFrom("folders")
      .select(["id", "imap_name", "idle_requested", "idle_status"])
      .where("account_id", "=", this.accountId)
      .where("deleted_at", "is", null)
      .execute();

    for (const folder of folders) {
      let status: string;
      if (!folder.idle_requested) {
        status = "off";
      } else if (!supported) {
        status = "unsupported";
      } else {
        status = watching.has(folder.imap_name) ? "watching" : "failed";
      }
      if (folder.idle_status === status) continue;

      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("folders")
          .set({ idle_status: status })
          .where("id", "=", folder.id)
          .execute(),
      );
    }
  }

  /** Bring the watched set in line with what the rows now ask for. */
  private async refreshIdleFolders(remoteFolders: FolderInfo[]): Promise<void> {
    // Seeding and status both run whether or not a watcher exists, so a server without
    // IDLE reports 'unsupported' for what was asked for rather than a blanket 'off'.
    const wanted = await this.resolveIdleFolders(remoteFolders);
    if (this.idleWatcher) {
      await this.idleWatcher.setFolders(wanted);
    }
    await this.writeIdleStatus();
  }

  /** A watch that has stopped for good: say so on the row, and tell the consumer. */
  private async reportAbandonedIdle(folderImapName: string, error: string): Promise<void> {
    const folder = await this.db
      .selectFrom("folders")
      .select("id")
      .where("account_id", "=", this.accountId)
      .where("imap_name", "=", folderImapName)
      .executeTakeFirst();
    if (!folder) return;

    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("folders")
        .set({ idle_status: "failed" })
        .where("id", "=", folder.id)
        .execute(),
    );
    await this.db
      .insertInto("sync_notifications")
      .values({
        account_id: this.accountId,
        action: "idle",
        folder_id: folder.id,
        error,
        detail: { folder: folderImapName },
      })
      .execute();
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
      "Scheduling retry",
    );

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.start().catch((err) => {
        log.error({ err, accountId: this.accountId }, "Retry failed");
      });
    }, delay);
  }

  private async cleanupForRetry(): Promise<void> {
    // Stop periodic sync
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    // Stop IDLE watcher
    if (this.idleWatcher) {
      await this.idleWatcher.stop().catch(() => {});
      this.idleWatcher = null;
    }

    // Unsubscribe outbound and outbox
    await this.outboundProcessor.unsubscribeAccount(this.accountId).catch(() => {});
    await this.outboxProcessor.unsubscribeAccount(this.accountId).catch(() => {});

    // Disconnect IMAP
    if (this.imapClient) {
      await this.imapClient.disconnect().catch(() => {});
      this.imapClient = null;
    }

    this.capabilities = null;
  }

  private async transitionState(newState: AccountState, errorMsg?: string): Promise<void> {
    const oldState = this.state;
    this.state = newState;

    log.info(
      { accountId: this.accountId, from: oldState, to: newState },
      "Account state transition",
    );

    try {
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("accounts")
          .set({
            state: newState,
            state_error: newState === "error" ? (errorMsg ?? null) : null,
          })
          .where("id", "=", this.accountId)
          .execute(),
      );
    } catch (err) {
      log.error({ err, accountId: this.accountId }, "Failed to persist state transition");
    }
  }

  private async getAccountRow(): Promise<AccountRow | null> {
    const row = await this.db
      .selectFrom("accounts")
      .select(["id", "imap_host", "imap_port", "imap_user", "imap_password", "is_active"])
      .where("id", "=", this.accountId)
      .executeTakeFirst();

    return row ?? null;
  }

  private async getDbFolders(): Promise<
    { id: string; imap_name: string; initial_sync_done: boolean }[]
  > {
    return this.db
      .selectFrom("folders")
      .select(["id", "imap_name", "initial_sync_done"])
      .where("account_id", "=", this.accountId)
      .where("deleted_at", "is", null)
      .execute();
  }

  /**
   * LIST the server and reconcile the folder list into PG, returning what the server
   * reported. Folders whose MAILBOXID is already stored are excluded from the per-folder
   * open that reads it, so a repeated discovery costs one LIST.
   */
  private async discoverAndSyncFolders(): Promise<FolderInfo[]> {
    if (!this.imapClient || !this.capabilities) return [];

    const resolved = await this.db
      .selectFrom("folders")
      .select("imap_name")
      .where("account_id", "=", this.accountId)
      .where("deleted_at", "is", null)
      .where("mailbox_id", "is not", null)
      .execute();

    const remoteFolders = await discoverFolders(
      this.imapClient.client,
      new Set(resolved.map((r) => r.imap_name)),
    );
    await syncFoldersToPg(this.db, this.accountId, remoteFolders, this.capabilities);
    return remoteFolders;
  }
}
