import type { ImapFlowOptions } from "imapflow";
import { ImapFlow } from "imapflow";
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

  constructor(
    private config: IdleWatcherConfig,
    private folders: string[],
    private onNotification: (folder: string) => Promise<void>,
    private restartInterval = 300_000,
    /** Called when a folder's watch has exhausted its reconnect attempts and stopped. */
    private onGiveUp?: (folder: string, error: string) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    await this.setFolders(this.folders);
  }

  /**
   * Make the set of watched folders match `names`, starting and stopping only the
   * difference.
   *
   * Which folders get push is a per-account choice a consumer changes at runtime, so the
   * watcher cannot be a fixed list decided once at account start -- it has to be able to
   * pick up and drop folders while running.
   */
  async setFolders(names: string[]): Promise<void> {
    const wanted = new Set(names);
    this.folders = [...wanted];

    for (const [folder, idle] of [...this.connections]) {
      if (wanted.has(folder)) continue;
      this.connections.delete(folder);
      await idle.stop().catch((err) => {
        log.warn({ err, folder }, "Error stopping IDLE connection");
      });
    }

    for (const folder of wanted) {
      if (this.connections.has(folder)) continue;
      const idle = new FolderIdle(
        this.config,
        folder,
        this.onNotification,
        this.restartInterval,
        this.onGiveUp,
      );
      this.connections.set(folder, idle);
      // Start without awaiting — each folder connects independently
      idle.start().catch((err) => {
        log.error({ err, folder }, "Failed to start IDLE for folder");
      });
    }
  }

  /** The folders currently held open, which is what `idle_status` is written from. */
  get watchedFolders(): string[] {
    return [...this.connections.keys()];
  }

  async stop(): Promise<void> {
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

  /** Number of dedicated IMAP connections currently held open (one per watched folder). */
  get watchedFolderCount(): number {
    return this.connections.size;
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
  private notifying = false;
  private notifyAgain = false;
  private reconnecting = false;

  constructor(
    private config: IdleWatcherConfig,
    private folder: string,
    private onNotification: (folder: string) => Promise<void>,
    private restartInterval: number,
    private onGiveUp?: (folder: string, error: string) => Promise<void>,
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

      // Attach the catch before racing: if logout() loses the race and rejects afterward,
      // it must not surface as an unhandled rejection.
      const logoutPromise = client.logout().catch(() => {});
      await Promise.race([
        logoutPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
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

  /**
   * Run one sync per burst rather than one per event.
   *
   * A server reports exists, expunge and flags separately, so another client marking fifty
   * messages read arrives as fifty notifications within a moment of each other -- fifty
   * near-simultaneous full change-detection passes for one change. A run in flight absorbs
   * whatever arrives during it and repeats once afterwards, so nothing is missed and the
   * duplicates collapse. Same shape as the outbound processor's per-account guard.
   */
  private handleNotification(): void {
    log.debug({ folder: this.folder }, "IDLE notification received");
    if (this.notifying) {
      this.notifyAgain = true;
      return;
    }

    this.notifying = true;
    void (async () => {
      try {
        do {
          this.notifyAgain = false;
          await this.onNotification(this.folder);
        } while (this.notifyAgain && !this.stopped);
      } catch (err) {
        log.error({ err, folder: this.folder }, "Notification handler error");
      } finally {
        this.notifying = false;
      }
    })();
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

  /**
   * A failed connection announces itself twice: the promise rejects, and the client also
   * emits 'close' a tick later. Both paths land here, and two loops racing over the same
   * `this.client` field means one can destroy the connection the other just established --
   * which emits another 'close' and spawns another loop. Each would also count its own
   * retries and report giving up separately, so one folder could hold several connections
   * against a budget the whole feature is built around being small.
   */
  private async reconnectWithBackoff(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.runReconnectLoop();
    } finally {
      this.reconnecting = false;
    }
  }

  private async runReconnectLoop(): Promise<void> {
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

        // Deliberately not connectAndIdle(): that one recovers from its own failures by
        // calling back into here, which this loop's guard now refuses -- so it would end
        // the whole episode after a single attempt.
        const connectedAt = Date.now();
        await this.createConnection();
        await this.runIdleLoop();
        if (this.stopped) return;

        // The idle loop only ends when the connection died, so this is another attempt
        // rather than success. A connection that survived longer than one IDLE restart
        // interval was a working one, though, and should not spend the folder's budget.
        if (Date.now() - connectedAt >= this.restartInterval) {
          attempt = -1;
        }
      } catch (err) {
        log.warn({ err, folder: this.folder, attempt: attempt + 1 }, "Reconnect attempt failed");
      }
    }

    // Reconnection stopping is the one failure here that leaves nothing behind: the folder
    // quietly stops being real-time while still syncing on the interval, so nothing looks
    // broken and nobody is told. Say so.
    log.error({ folder: this.folder }, "All IDLE reconnect attempts exhausted");
    if (this.onGiveUp && !this.stopped) {
      await this.onGiveUp(this.folder, `IDLE gave up after ${maxRetries} reconnect attempts`).catch(
        (err) => {
          log.error({ err, folder: this.folder }, "Failed to report an abandoned IDLE watch");
        },
      );
    }
  }
}
