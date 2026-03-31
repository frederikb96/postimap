import { ImapFlow } from "imapflow";
import type { ImapFlowOptions } from "imapflow";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";

const log = createLogger("idle-watcher");

export interface IdleWatcherConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure?: boolean;
  tls?: ImapFlowOptions["tls"];
}

/**
 * Watches IMAP folders via IDLE for near-real-time change detection.
 * Creates a dedicated IMAP connection per folder (IMAP protocol limitation).
 * Auto-restarts IDLE before NAT/firewall timeouts and reconnects on disconnect.
 */
export class IdleWatcher {
  private connections = new Map<string, FolderIdle>();
  private stopped = false;

  constructor(
    private config: IdleWatcherConfig,
    private folders: string[],
    private onNotification: (folder: string) => Promise<void>,
    private restartInterval = 300_000,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;

    for (const folder of this.folders) {
      const idle = new FolderIdle(this.config, folder, this.onNotification, this.restartInterval);
      this.connections.set(folder, idle);
      // Start without awaiting — each folder connects independently
      idle.start().catch((err) => {
        log.error({ err, folder }, "Failed to start IDLE for folder");
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const promises: Promise<void>[] = [];
    for (const [folder, idle] of this.connections) {
      promises.push(
        idle.stop().catch((err) => {
          log.warn({ err, folder }, "Error stopping IDLE connection");
        }),
      );
    }
    await Promise.all(promises);
    this.connections.clear();
  }
}

/**
 * Manages a single IDLE connection for one folder.
 * Handles reconnection with backoff and periodic IDLE restart.
 */
class FolderIdle {
  private client: ImapFlow | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePromise: Promise<boolean> | null = null;

  constructor(
    private config: IdleWatcherConfig,
    private folder: string,
    private onNotification: (folder: string) => Promise<void>,
    private restartInterval: number,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectAndIdle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRestartTimer();

    if (this.client) {
      const client = this.client;
      this.client = null;
      client.removeAllListeners();
      client.on("error", () => {});

      // Race logout against a hard close timeout
      const forceClose = () => {
        try {
          client.close();
        } catch {
          // Already closed
        }
      };

      try {
        await Promise.race([
          client.logout(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch {
        // Logout threw, force close
      }
      forceClose();
    }
  }

  private async connectAndIdle(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.createConnection();
      await this.runIdleLoop();
    } catch (err) {
      log.error({ err, folder: this.folder }, "IDLE connection error");
      if (!this.stopped) {
        await this.reconnectWithBackoff();
      }
    }
  }

  private async createConnection(): Promise<void> {
    const { host, port, user, password, secure, tls } = this.config;

    let resolvedSecure: boolean;
    if (secure !== undefined) {
      resolvedSecure = secure;
    } else if (port === 993) {
      resolvedSecure = true;
    } else if (port === 143) {
      resolvedSecure = false;
    } else {
      resolvedSecure = false;
    }

    const flowOpts: ImapFlowOptions = {
      host,
      port,
      secure: resolvedSecure,
      auth: { user, pass: password },
      logger: false,
      tls: tls ?? { rejectUnauthorized: true },
      disableAutoIdle: true,
    };

    if (!resolvedSecure && port === 143) {
      flowOpts.doSTARTTLS = true;
    }

    this.client = new ImapFlow(flowOpts);

    this.client.on("close", () => {
      log.info({ folder: this.folder }, "IDLE connection closed");
      if (!this.stopped) {
        this.reconnectWithBackoff().catch((err) => {
          log.error({ err, folder: this.folder }, "Reconnect failed");
        });
      }
    });

    this.client.on("error", (err: Error) => {
      log.warn({ err, folder: this.folder }, "IDLE connection error");
    });

    // Notify on EXISTS (new messages), EXPUNGE (deleted), FLAGS (changed)
    this.client.on("exists", () => {
      this.handleNotification();
    });

    this.client.on("expunge", () => {
      this.handleNotification();
    });

    this.client.on("flags", () => {
      this.handleNotification();
    });

    await this.client.connect();
    log.info({ folder: this.folder, host }, "IDLE connection established");

    // Open the folder
    await this.client.mailboxOpen(this.folder);
  }

  private async runIdleLoop(): Promise<void> {
    while (!this.stopped && this.client?.usable) {
      // Start IDLE
      this.scheduleRestart();

      try {
        this.idlePromise = this.client.idle();
        await this.idlePromise;
      } catch (err) {
        if (!this.stopped) {
          log.warn({ err, folder: this.folder }, "IDLE interrupted");
        }
      } finally {
        this.idlePromise = null;
        this.clearRestartTimer();
      }

      // IDLE broke (notification or restart timer). If not stopped, loop continues.
    }
  }

  private handleNotification(): void {
    log.debug({ folder: this.folder }, "IDLE notification received");
    // The notification callback is fire-and-forget from the event handler.
    // The IDLE loop will resume after the callback completes.
    this.onNotification(this.folder).catch((err) => {
      log.error({ err, folder: this.folder }, "Notification handler error");
    });
  }

  private scheduleRestart(): void {
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      if (this.client?.idling && !this.stopped) {
        log.debug({ folder: this.folder }, "Restarting IDLE (periodic)");
        // Breaking IDLE by issuing NOOP, which causes idle() promise to resolve
        this.client.noop().catch(() => {});
      }
    }, this.restartInterval);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private async reconnectWithBackoff(): Promise<void> {
    if (this.stopped) return;

    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (this.stopped) return;

      const delay = computeDelay(attempt, {
        maxRetries,
        baseDelay: 2_000,
        maxDelay: 300_000,
        jitter: true,
      });

      log.info(
        { folder: this.folder, attempt: attempt + 1, delayMs: Math.round(delay) },
        "Reconnecting IDLE",
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      if (this.stopped) return;

      try {
        // Clean up old client
        if (this.client) {
          this.client.removeAllListeners();
          this.client.on("error", () => {});
          try {
            this.client.close();
          } catch {
            // Already closed
          }
          this.client = null;
        }

        await this.connectAndIdle();
        return;
      } catch (err) {
        log.warn({ err, folder: this.folder, attempt: attempt + 1 }, "Reconnect attempt failed");
      }
    }

    log.error({ folder: this.folder }, "All IDLE reconnect attempts exhausted");
  }
}
