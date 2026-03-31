import { EventEmitter } from "node:events";
import { ImapFlow } from "imapflow";
import type { ImapFlowOptions, MailboxLockObject, MailboxObject } from "imapflow";
import { createLogger } from "../util/logger.js";
import { type RetryOptions, computeDelay } from "../util/retry.js";

export interface ImapClientOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Override TLS behavior. If omitted, auto-detected from port. */
  secure?: boolean;
  /** Reconnection backoff settings */
  retry?: Partial<RetryOptions>;
  /** Custom ImapFlow logger; false to disable */
  imapLogger?: ImapFlowOptions["logger"];
  /** TLS options passed to ImapFlow */
  tls?: ImapFlowOptions["tls"];
}

export interface ImapClientEvents {
  connected: [];
  disconnected: [error?: Error];
  error: [error: Error];
  mailboxChange: [event: { path: string; count: number; prevCount: number }];
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 5,
  baseDelay: 1_000,
  maxDelay: 300_000,
  jitter: true,
};

/**
 * Thin wrapper around ImapFlow providing auto-reconnection and event forwarding.
 *
 * SSL/STARTTLS auto-detection:
 *  - Port 993 -> implicit TLS (secure: true)
 *  - Port 143 -> STARTTLS (secure: false, requireTLS: true)
 *  - Other   -> plain (secure: false) for testing
 */
export class ImapClient extends EventEmitter<ImapClientEvents> {
  private flow: ImapFlow | null = null;
  private readonly log = createLogger("imap-client");
  private readonly opts: ImapClientOptions;
  private readonly retryOpts: RetryOptions;
  private shuttingDown = false;
  private reconnecting = false;

  constructor(opts: ImapClientOptions) {
    super();
    this.opts = opts;
    this.retryOpts = { ...DEFAULT_RETRY, ...opts.retry };
  }

  /** Build ImapFlow options from our config with SSL auto-detection */
  private buildFlowOptions(): ImapFlowOptions {
    const { host, port, user, password, secure, tls } = this.opts;

    let resolvedSecure: boolean;
    let requireTLS = false;

    if (secure !== undefined) {
      resolvedSecure = secure;
    } else if (port === 993) {
      resolvedSecure = true;
    } else if (port === 143) {
      resolvedSecure = false;
      requireTLS = true;
    } else {
      resolvedSecure = false;
    }

    const flowOpts: ImapFlowOptions = {
      host,
      port,
      secure: resolvedSecure,
      auth: { user, pass: password },
      logger: this.opts.imapLogger ?? false,
      tls: tls ?? { rejectUnauthorized: true },
      disableAutoIdle: true,
    };

    if (requireTLS) {
      flowOpts.doSTARTTLS = true;
    }

    return flowOpts;
  }

  /** Connect to the IMAP server */
  async connect(): Promise<void> {
    this.shuttingDown = false;
    const flowOpts = this.buildFlowOptions();
    this.flow = new ImapFlow(flowOpts);

    this.flow.on("close", () => {
      this.log.info("Connection closed");
      this.emit("disconnected");
      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.flow.on("error", (err: Error) => {
      this.log.error({ err }, "IMAP error");
      this.emit("error", err);
    });

    this.flow.on("exists", (event: { path: string; count: number; prevCount: number }) => {
      this.emit("mailboxChange", event);
    });

    await this.flow.connect();
    this.log.info({ host: this.opts.host, port: this.opts.port }, "Connected");
    this.emit("connected");
  }

  /** Graceful disconnect without auto-reconnect */
  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.flow) {
      const flow = this.flow;
      this.flow = null;
      // Replace listeners with no-ops to prevent reconnection and suppress errors
      flow.removeAllListeners();
      flow.on("error", () => {});

      // Race logout against a hard close timeout
      const forceClose = () => {
        try {
          flow.close();
        } catch {
          // Already closed
        }
      };

      try {
        await Promise.race([
          flow.logout(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch {
        // Logout threw, force close
      }
      forceClose();
    }
  }

  /** Whether the underlying ImapFlow client is connected and usable */
  isConnected(): boolean {
    return this.flow?.usable === true;
  }

  /** Access the underlying ImapFlow instance for advanced operations */
  get client(): ImapFlow {
    if (!this.flow) {
      throw new Error("ImapClient is not connected");
    }
    return this.flow;
  }

  /** Acquire a mailbox lock for IDLE or other exclusive operations */
  async getMailboxLock(folder: string): Promise<MailboxLockObject> {
    return this.client.getMailboxLock(folder);
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.shuttingDown) return;
    this.reconnecting = true;

    const attempt = async () => {
      for (let i = 0; i <= this.retryOpts.maxRetries; i++) {
        if (this.shuttingDown) {
          this.reconnecting = false;
          return;
        }
        try {
          this.log.info({ attempt: i + 1 }, "Reconnecting...");
          await this.connect();
          this.reconnecting = false;
          return;
        } catch (err) {
          this.log.warn({ err, attempt: i + 1 }, "Reconnect attempt failed");
          if (i < this.retryOpts.maxRetries) {
            const delay = computeDelay(i, this.retryOpts);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      this.reconnecting = false;
      this.log.error("All reconnect attempts exhausted");
      this.emit("error", new Error("All reconnect attempts exhausted"));
    };

    attempt().catch((err) => {
      this.reconnecting = false;
      this.log.error({ err }, "Reconnection loop failed unexpectedly");
    });
  }
}
