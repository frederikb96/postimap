import type { Kysely } from "kysely";
import { decryptPassword } from "../crypto.js";
import type { Database } from "../db/schema.js";
import {
  type ServerCapabilities,
  cacheCapabilities,
  detectCapabilities,
  selectSyncTier,
} from "../imap/capabilities.js";
import { ImapClient } from "../imap/pool.js";
import { type FolderInfo, discoverFolders, syncFoldersToPg } from "../protocol/folder-sync.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import { IdleWatcher, type IdleWatcherConfig } from "./idle-watcher.js";
import { InboundSync } from "./inbound.js";
import type { OutboundProcessor } from "./outbound.js";
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

  constructor(
    private accountId: string,
    private db: Kysely<Database>,
    private config: {
      SYNC_INTERVAL_SECONDS: number;
      IDLE_RESTART_SECONDS: number;
      IMAP_TLS_REJECT_UNAUTHORIZED: boolean;
      ENCRYPTION_KEY?: string;
    },
    private databaseUrl: string,
    private outboundProcessor: OutboundProcessor,
  ) {}

  async start(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.transitionState("syncing");

      // 1. Read account credentials from PG
      const account = await this.getAccountRow();
      if (!account || !account.is_active) {
        await this.transitionState("disabled");
        return;
      }

      // 2. Create IMAP client and connect
      this.imapClient = new ImapClient({
        host: account.imap_host,
        port: account.imap_port,
        user: account.imap_user,
        password: decryptPassword(account.imap_password, this.config.ENCRYPTION_KEY),
        tls: { rejectUnauthorized: this.config.IMAP_TLS_REJECT_UNAUTHORIZED },
      });

      await this.imapClient.connect();

      // 3. Detect and cache capabilities
      this.capabilities = detectCapabilities(this.imapClient.client);
      await cacheCapabilities(this.db, this.accountId, this.capabilities);

      // 4. Discover and sync folders
      const remoteFolders = await discoverFolders(this.imapClient.client);
      await syncFoldersToPg(this.db, this.accountId, remoteFolders, this.capabilities);

      // 5. Full sync all folders
      const inbound = new InboundSync(this.imapClient, this.db, this.accountId, this.capabilities);

      const folders = await this.getDbFolders();
      let totalMessages = 0;
      let totalErrors = 0;

      for (const folder of folders) {
        const result = await inbound.fullSync(folder.id, folder.imap_name);
        totalMessages += result.newMessages;
        totalErrors += result.errors.length;
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

      // 6. Subscribe outbound processor for this account
      await this.outboundProcessor.subscribeAccount(this.accountId);

      // 7. Start IDLE watcher for folders with IDLE support
      if (this.capabilities.idle && remoteFolders.length > 0) {
        await this.startIdleWatcher(account, remoteFolders);
      }

      // 8. Start periodic incremental sync
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

    // Unsubscribe outbound processor
    await this.outboundProcessor.unsubscribeAccount(this.accountId).catch((err) => {
      log.warn({ err, accountId: this.accountId }, "Error unsubscribing outbound");
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

  private async periodicSync(): Promise<void> {
    if (this.stopped || this.syncing || this.state !== "active") return;

    this.syncing = true;
    try {
      if (!this.imapClient || !this.capabilities) return;

      const inbound = new InboundSync(this.imapClient, this.db, this.accountId, this.capabilities);

      const folders = await this.getDbFolders();
      let totalNew = 0;
      let totalUpdated = 0;
      let totalDeleted = 0;
      let totalErrors = 0;

      for (const folder of folders) {
        const result = await inbound.syncFolder(folder.id, folder.imap_name);
        totalNew += result.newMessages;
        totalUpdated += result.updatedFlags;
        totalDeleted += result.deletedMessages;
        totalErrors += result.errors.length;
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

    // Watch all folders via IDLE
    const folderNames = remoteFolders.map((f) => f.imapName);

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
            .executeTakeFirst();

          if (!dbFolder) return;

          const inbound = new InboundSync(
            this.imapClient,
            this.db,
            this.accountId,
            this.capabilities,
          );

          await inbound.syncFolder(dbFolder.id, dbFolder.imap_name);
        } catch (err) {
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

    // Unsubscribe outbound
    await this.outboundProcessor.unsubscribeAccount(this.accountId).catch(() => {});

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
      await this.db
        .updateTable("accounts")
        .set({
          state: newState,
          state_error: newState === "error" ? (errorMsg ?? null) : null,
          updated_at: new Date(),
        })
        .where("id", "=", this.accountId)
        .execute();
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
      .execute();
  }
}
