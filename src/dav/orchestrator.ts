import type { Kysely } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import { createLogger } from "../util/logger.js";
import { type DavAccountState, DavAccountSync, type DavAccountSyncConfig } from "./account-sync.js";
import type { DavClient } from "./client.js";
import { DavOutboundProcessor } from "./outbound.js";
import { type DavRetentionConfig, DavRetentionJob } from "./retention.js";

const log = createLogger("dav-orchestrator");

export interface DavAccountStatus {
  accountId: string;
  state: DavAccountState;
}

export interface DavOrchestratorStatus {
  running: boolean;
  accounts: DavAccountStatus[];
  summary: Record<DavAccountState, number>;
}

/**
 * Top-level DAV sync loop, alongside `sync/orchestrator.ts`'s IMAP one -- a sibling
 * process, not woven into it, since neither the account lifecycle nor the outbound queue
 * share a type with the IMAP side.
 */
export class DavOrchestrator {
  private accounts = new Map<string, DavAccountSync>();
  private subscriber: Subscriber | null = null;
  private outboundProcessor: DavOutboundProcessor | null = null;
  private retentionJob: DavRetentionJob | null = null;
  private running = false;

  constructor(
    private db: Kysely<Database>,
    private config: DavAccountSyncConfig & {
      OUTBOUND_POLL_SECONDS: number;
      RETENTION: DavRetentionConfig;
      RETENTION_INTERVAL_HOURS: number;
    },
    private databaseUrl: string,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.outboundProcessor = new DavOutboundProcessor(
      this.db,
      this.databaseUrl,
      (accountId) => this.getClientForAccount(accountId),
      this.config.OUTBOUND_POLL_SECONDS * 1_000,
    );
    await this.outboundProcessor.start();

    this.retentionJob = new DavRetentionJob(
      this.db,
      this.config.RETENTION,
      this.config.RETENTION_INTERVAL_HOURS * 60 * 60 * 1_000,
    );
    this.retentionJob.start();

    const activeAccounts = await this.db
      .selectFrom("dav_accounts")
      .select("id")
      .where("is_active", "=", true)
      .execute();
    for (const account of activeAccounts) {
      await this.startAccount(account.id);
    }

    this.subscriber = await createPgListener(this.databaseUrl);
    await this.subscriber.connect();

    this.subscriber.notifications.on("postimap_events", (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const event = payload as { type?: string; account_id?: string };
      if (event.type !== "dav_account" || !event.account_id) return;
      this.onAccountChange(event.account_id).catch((err) => {
        log.error({ err, accountId: event.account_id }, "Failed to handle DAV account change");
      });
    });

    this.subscriber.notifications.on("postimap_commands", (payload) => {
      if (typeof payload === "object" && payload !== null) {
        const cmd = payload as { action?: string; account_id?: string };
        if (cmd.action === "sync" && cmd.account_id && this.accounts.has(cmd.account_id)) {
          this.onSyncRequest(cmd.account_id).catch((err) => {
            log.error({ err, accountId: cmd.account_id }, "Failed to handle DAV sync request");
          });
        }
      }
    });

    await this.subscriber.listenTo("postimap_events");
    await this.subscriber.listenTo("postimap_commands");

    log.info({ accountCount: activeAccounts.length }, "DAV orchestrator started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

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
      } catch {}
    }

    const stopPromises: Promise<void>[] = [];
    for (const [accountId, accountSync] of this.accounts) {
      stopPromises.push(
        accountSync
          .stop()
          .catch((err) => log.warn({ err, accountId }, "Error stopping DAV account sync")),
      );
    }
    await Promise.all(stopPromises);
    this.accounts.clear();

    if (this.outboundProcessor) {
      await this.outboundProcessor.stop();
      this.outboundProcessor = null;
    }
    if (this.retentionJob) {
      await this.retentionJob.stop();
      this.retentionJob = null;
    }

    log.info("DAV orchestrator stopped");
  }

  getStatus(): DavOrchestratorStatus {
    const accounts: DavAccountStatus[] = [];
    const summary: Record<DavAccountState, number> = {
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

  private async onSyncRequest(accountId: string): Promise<void> {
    const accountSync = this.accounts.get(accountId);
    if (!accountSync) return;
    await accountSync.requestSync();
  }

  private async onAccountChange(accountId: string): Promise<void> {
    const account = await this.db
      .selectFrom("dav_accounts")
      .select(["id", "is_active"])
      .where("id", "=", accountId)
      .executeTakeFirst();
    const existing = this.accounts.get(accountId);

    if (!account) {
      if (existing) {
        await existing.stop();
        this.accounts.delete(accountId);
      }
      return;
    }

    if (account.is_active) {
      if (!existing) {
        await this.startAccount(accountId);
      } else if (existing.getState() === "disabled") {
        await existing.stop();
        this.accounts.delete(accountId);
        await this.startAccount(accountId);
      }
    } else if (existing) {
      await existing.stop();
      this.accounts.delete(accountId);
    }
  }

  private async startAccount(accountId: string): Promise<void> {
    if (!this.outboundProcessor || !this.running) return;
    const accountSync = new DavAccountSync(accountId, this.db, this.config, this.outboundProcessor);
    this.accounts.set(accountId, accountSync);
    accountSync
      .start()
      .catch((err) => log.error({ err, accountId }, "DAV account sync start failed"));
  }

  private getClientForAccount(accountId: string): DavClient {
    const accountSync = this.accounts.get(accountId);
    const client = accountSync?.getClient();
    if (!client) throw new Error(`No DavClient for account ${accountId}`);
    return client;
  }
}
