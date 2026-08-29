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
      const remoteFolders = await discoverFolders(this.imapClient.client);
      await syncFoldersToPg(this.db, this.accountId, remoteFolders, this.capabilities);
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
      );

      const folders = await this.getDbFolders();
      let totalMessages = 0;
      let totalErrors = 0;

      for (const folder of folders) {
        throwIfAborted(signal);
        const result = await inbound.fullSync(folder.id, folder.imap_name, true, signal);
        totalMessages += result.newMessages;
        totalErrors += result.errors.length;
        if (result.connectionLost) {
          throw new Error(`IMAP connection lost during initial sync of folder ${folder.imap_name}`);
        }
      }

      // Update sync_state after initial full sync
      const tier = selectSyncTier(this.capabilities);
      await updateSyncState(this.db, this.accountId, {
        syncTier: tier,
        foldersSynced: folders.length,
        foldersTotal: folders.length,
        messagesSynced: BigInt(totalMessages),
        errorCount: totalErrors,
        lastError: null,
        isIncremental: false,
      });

      // Subscribe outbound and outbox processors for this account
      await this.outboundProcessor.subscribeAccount(this.accountId);
      await this.outboxProcessor.subscribeAccount(this.accountId);

      // Start IDLE watcher for folders with IDLE support
      if (this.capabilities.idle && remoteFolders.length > 0) {
        await this.startIdleWatcher(account, remoteFolders);
      }

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
      );

      const folders = await this.getDbFolders();
      let totalNew = 0;
      let totalUpdated = 0;
      let totalDeleted = 0;
      let totalErrors = 0;

      for (const folder of folders) {
        throwIfAborted(signal);
        const result = await inbound.syncFolder(folder.id, folder.imap_name, signal);
        totalNew += result.newMessages;
        totalUpdated += result.updatedFlags;
        totalDeleted += result.deletedMessages;
        totalErrors += result.errors.length;
        if (result.connectionLost) {
          throw new Error(`IMAP connection lost during sync of folder ${folder.imap_name}`);
        }
      }

      await updateSyncState(this.db, this.accountId, {
        foldersSynced: folders.length,
        foldersTotal: folders.length,
        messagesSynced: BigInt(totalNew),
        errorCount: totalErrors,
        lastError: totalErrors > 0 ? "Some folders had sync errors" : null,
        isIncremental: true,
      });

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

  private async startIdleWatcher(account: AccountRow, remoteFolders: FolderInfo[]): Promise<void> {
    const idleConfig: IdleWatcherConfig = {
      host: account.imap_host,
      port: account.imap_port,
      user: account.imap_user,
      password: decryptPassword(account.imap_password, this.config.ENCRYPTION_KEY),
      tls: { rejectUnauthorized: this.config.IMAP_TLS_REJECT_UNAUTHORIZED },
    };

    // Watch only the configured folders via IDLE -- each one holds open its own dedicated
    // IMAP connection (IDLE occupies the whole connection, so there is no way to share
    // one across folders), and an account with many folders would otherwise open one
    // connection per folder against a server that typically caps concurrent connections
    // per account well below that.
    const remoteFolderNames = new Set(remoteFolders.map((f) => f.imapName));
    const folderNames = this.config.IDLE_FOLDERS.filter((name) => remoteFolderNames.has(name));
    const missing = this.config.IDLE_FOLDERS.filter((name) => !remoteFolderNames.has(name));
    if (missing.length > 0) {
      log.info(
        { accountId: this.accountId, missing },
        "Configured idle_folders not present on this account, skipping",
      );
    }
    if (folderNames.length === 0) {
      log.warn(
        { accountId: this.accountId, idleFolders: this.config.IDLE_FOLDERS },
        "No configured idle_folders present on this account, IDLE watcher not started",
      );
      return;
    }

    this.idleWatcher = new IdleWatcher(
      idleConfig,
      folderNames,
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
          );

          await inbound.syncFolder(dbFolder.id, dbFolder.imap_name, this.abortController.signal);
        } catch (err) {
          if (err instanceof SyncAbortedError) return;
          log.error({ err, accountId: this.accountId, folder }, "IDLE-triggered sync failed");
        }
      },
      this.config.IDLE_RESTART_SECONDS * 1_000,
    );

    await this.idleWatcher.start();
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

  private async getDbFolders(): Promise<{ id: string; imap_name: string }[]> {
    return this.db
      .selectFrom("folders")
      .select(["id", "imap_name"])
      .where("account_id", "=", this.accountId)
      .where("deleted_at", "is", null)
      .execute();
  }
}
