import type { Kysely } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import type { ServerCapabilities } from "../imap/capabilities.js";
import type { ImapClient } from "../imap/pool.js";
import { createLogger } from "../util/logger.js";
import { type AccountState, AccountSync } from "./account-sync.js";
import { OutboundProcessor } from "./outbound.js";

const log = createLogger("orchestrator");

export interface AccountStatus {
  accountId: string;
  state: AccountState;
}

export interface OrchestratorStatus {
  running: boolean;
  accounts: AccountStatus[];
  summary: Record<AccountState, number>;
}

export class Orchestrator {
  private accounts = new Map<string, AccountSync>();
  private subscriber: Subscriber | null = null;
  private outboundProcessor: OutboundProcessor | null = null;
  private running = false;

  constructor(
    private db: Kysely<Database>,
    private config: {
      SYNC_INTERVAL_SECONDS: number;
      IDLE_RESTART_SECONDS: number;
      OUTBOUND_POLL_SECONDS: number;
      MAX_RETRY_ATTEMPTS: number;
    },
    private databaseUrl: string,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Create shared outbound processor
    this.outboundProcessor = new OutboundProcessor(
      this.db,
      this.databaseUrl,
      (accountId) => this.getImapClientForAccount(accountId),
      (accountId) => this.getCapabilitiesForAccount(accountId),
      this.config.OUTBOUND_POLL_SECONDS * 1_000,
      this.config.MAX_RETRY_ATTEMPTS,
    );
    await this.outboundProcessor.start();

    // 2. Query all active accounts and start AccountSync for each
    const activeAccounts = await this.db
      .selectFrom("accounts")
      .select("id")
      .where("is_active", "=", true)
      .execute();

    for (const account of activeAccounts) {
      await this.startAccount(account.id);
    }

    // 3. Subscribe to account_changes NOTIFY channel
    this.subscriber = await createPgListener(this.databaseUrl);
    await this.subscriber.connect();

    this.subscriber.notifications.on("account_changes", (payload) => {
      const accountId =
        typeof payload === "object" && payload !== null && "id" in payload
          ? String((payload as { id: unknown }).id)
          : String(payload);
      this.onAccountChange(accountId).catch((err) => {
        log.error({ err, accountId }, "Failed to handle account change");
      });
    });

    await this.subscriber.listenTo("account_changes");

    log.info({ accountCount: activeAccounts.length }, "Orchestrator started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Unsubscribe from NOTIFY (with timeout to avoid hanging)
    if (this.subscriber) {
      const sub = this.subscriber;
      this.subscriber = null;
      try {
        await Promise.race([
          (async () => {
            try {
              await sub.unlistenAll();
            } catch {}
            await sub.close();
          })(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Stop all AccountSync instances
    const stopPromises: Promise<void>[] = [];
    for (const [accountId, accountSync] of this.accounts) {
      stopPromises.push(
        accountSync.stop().catch((err) => {
          log.warn({ err, accountId }, "Error stopping account sync");
        }),
      );
    }
    await Promise.all(stopPromises);
    this.accounts.clear();

    // Stop outbound processor
    if (this.outboundProcessor) {
      await this.outboundProcessor.stop();
      this.outboundProcessor = null;
    }

    log.info("Orchestrator stopped");
  }

  getStatus(): OrchestratorStatus {
    const accounts: AccountStatus[] = [];
    const summary: Record<AccountState, number> = {
      created: 0,
      syncing: 0,
      active: 0,
      error: 0,
      disabled: 0,
    };

    for (const [accountId, accountSync] of this.accounts) {
      const state = accountSync.getState();
      accounts.push({ accountId, state });
      summary[state]++;
    }

    return { running: this.running, accounts, summary };
  }

  private async onAccountChange(accountId: string): Promise<void> {
    // Re-read the account from PG
    const account = await this.db
      .selectFrom("accounts")
      .select(["id", "is_active"])
      .where("id", "=", accountId)
      .executeTakeFirst();

    const existing = this.accounts.get(accountId);

    if (!account) {
      // Account was deleted
      if (existing) {
        log.info({ accountId }, "Account deleted, stopping sync");
        await existing.stop();
        this.accounts.delete(accountId);
      }
      return;
    }

    if (account.is_active) {
      if (!existing) {
        // New active account
        log.info({ accountId }, "New active account detected, starting sync");
        await this.startAccount(accountId);
      } else if (existing.getState() === "disabled") {
        // Re-activated account
        log.info({ accountId }, "Account re-activated, restarting sync");
        await existing.stop();
        this.accounts.delete(accountId);
        await this.startAccount(accountId);
      }
      // If account already exists and is active/syncing/error, the credentials
      // might have changed. Stop and restart.
      else {
        log.info({ accountId }, "Account updated, restarting sync");
        await existing.stop();
        this.accounts.delete(accountId);
        await this.startAccount(accountId);
      }
    } else {
      // Account deactivated
      if (existing) {
        log.info({ accountId }, "Account deactivated, stopping sync");
        await existing.stop();
        this.accounts.delete(accountId);
      }
    }
  }

  private async startAccount(accountId: string): Promise<void> {
    if (!this.outboundProcessor || !this.running) return;

    const accountSync = new AccountSync(
      accountId,
      this.db,
      this.config,
      this.databaseUrl,
      this.outboundProcessor,
    );

    this.accounts.set(accountId, accountSync);

    // Start async -- don't block orchestrator startup on individual accounts
    accountSync.start().catch((err) => {
      log.error({ err, accountId }, "Account sync start failed");
    });
  }

  private getImapClientForAccount(accountId: string): ImapClient {
    const accountSync = this.accounts.get(accountId);
    if (!accountSync) {
      throw new Error(`No AccountSync for account ${accountId}`);
    }
    const client = accountSync.getImapClient();
    if (!client) {
      throw new Error(`No ImapClient for account ${accountId}`);
    }
    return client;
  }

  private async getCapabilitiesForAccount(accountId: string): Promise<ServerCapabilities | null> {
    const accountSync = this.accounts.get(accountId);
    if (!accountSync) return null;
    return accountSync.getCapabilities();
  }
}
