import * as net from "node:net";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import { createLogger } from "../util/logger.js";
import type { Database } from "./schema.js";

const log = createLogger("db");

/** TLS options for the PostgreSQL connection. Undefined means no TLS. */
export interface DatabaseSslOptions {
  rejectUnauthorized: boolean;
  /** PEM-encoded CA certificate content, for a server whose cert isn't publicly trusted. */
  ca?: string;
}

/**
 * How long the service waits on the database before giving up. Without these, an await
 * on a connection whose peer has silently gone never settles -- behind a proxy or NAT
 * that still acknowledges TCP, keepalive probes included -- and whatever waits on it is
 * stuck until restart.
 */
export interface DatabaseBounds {
  /** Establishing a connection, TLS and startup included. */
  connectTimeoutSeconds: number;
  /** Waiting for a free pooled connection. */
  acquireTimeoutSeconds: number;
  /** An unused pooled connection is closed after this long. */
  idleTimeoutSeconds: number;
  /** Every connection is replaced after this long, however busy. */
  maxLifetimeSeconds: number;
  /**
   * The longest a connection may go without traffic either way. Waiting on a reply, that
   * is the longest one statement may run.
   */
  queryTimeoutSeconds: number;
}

/**
 * `bounds` is omitted only for migrations, where a single schema change can hold one
 * statement for minutes.
 */
export function createDatabase(
  databaseUrl: string,
  ssl?: DatabaseSslOptions,
  bounds?: DatabaseBounds,
): Kysely<Database> {
  const pg = postgres(databaseUrl, {
    ssl: ssl
      ? { rejectUnauthorized: ssl.rejectUnauthorized, ...(ssl.ca ? { ca: ssl.ca } : {}) }
      : undefined,
    ...(bounds
      ? {
          connect_timeout: bounds.connectTimeoutSeconds,
          idle_timeout: bounds.idleTimeoutSeconds,
          max_lifetime: bounds.maxLifetimeSeconds,
          socket: silenceBoundedSocket(bounds.queryTimeoutSeconds * 1_000),
        }
      : {}),
  });
  return new Kysely<Database>({
    dialect: new PostgresJSDialect({
      postgres: bounds ? guardReservations(pg, bounds.acquireTimeoutSeconds * 1_000) : pg,
    }),
  });
}

/**
 * The same postgres.js instance with `reserve()` -- how every query gets its connection --
 * made safe to lean on. It gives up after `acquireTimeoutMs` instead of queueing for a
 * connection forever, and a connection arriving after its caller gave up goes straight back
 * to the pool.
 *
 * A reservation whose connection was lost under it is never released. postgres.js has
 * already taken that connection out of service by then, and releasing it puts it back as
 * open: the next query written to it throws from a timer, outside any promise, and ends the
 * process.
 */
export function guardReservations(pg: postgres.Sql, acquireTimeoutMs: number): postgres.Sql {
  const reserve = (): Promise<postgres.ReservedSql> =>
    new Promise((resolve, reject) => {
      let gaveUp = false;
      const timer = setTimeout(() => {
        gaveUp = true;
        reject(new Error(`No database connection became free within ${acquireTimeoutMs} ms`));
      }, acquireTimeoutMs);
      pg.reserve().then(
        (reserved) => {
          if (gaveUp) {
            reserved.release();
            return;
          }
          clearTimeout(timer);
          resolve(guardRelease(reserved));
        },
        (err) => {
          clearTimeout(timer);
          if (!gaveUp) reject(err);
        },
      );
    });

  return new Proxy(pg, {
    get: (target, prop, receiver) =>
      prop === "reserve" ? reserve : Reflect.get(target, prop, receiver),
  });
}

/** Whether a query failed because its connection is gone, not because the server refused it. */
function isConnectionLoss(err: unknown): boolean {
  if (err instanceof postgres.PostgresError) return false;
  const { code, syscall } = (err ?? {}) as { code?: unknown; syscall?: unknown };
  return (typeof code === "string" && /^CONNECT(ION)?_/.test(code)) || typeof syscall === "string";
}

/** The reservation, released back to the pool only while its connection is alive. */
function guardRelease(reserved: postgres.ReservedSql): postgres.ReservedSql {
  let lost = false;
  return new Proxy(reserved, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return (...args: Parameters<postgres.ReservedSql["unsafe"]>) => {
          const pending = target.unsafe(...args);
          // Observed where the caller awaits it rather than awaited here, which would run a
          // query meant to be read through a cursor as an ordinary one.
          const then = pending.then.bind(pending);
          // biome-ignore lint/suspicious/noThenProperty: wraps the query's own then to observe how it ends
          pending.then = ((onFulfilled, onRejected) =>
            then(onFulfilled, (err: unknown) => {
              if (isConnectionLoss(err)) lost = true;
              if (onRejected) return onRejected(err);
              throw err;
            })) as typeof pending.then;
          return pending;
        };
      }
      if (prop === "release") {
        return () => {
          if (!lost) target.release();
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** postgres.js builds each connection's socket through this, for the host it was given. */
function silenceBoundedSocket(silenceMs: number) {
  return (options: { host: string[]; port: number[] }): net.Socket => {
    const socket = new SilenceBoundedSocket(silenceMs);
    socket.connect(options.port[0], options.host[0]);
    // postgres.js names the server for TLS from these, as it does for a socket of its own.
    Object.assign(socket, { host: options.host[0], port: options.port[0] });
    return socket;
  };
}

/**
 * A socket closed once it has carried no traffic either way for `silenceMs`, which fails
 * the query waiting on it with a connection error and takes the connection out of the pool.
 *
 * postgres.js strips every listener off the plain socket when it upgrades it to TLS, so the
 * handler is put back after any such call rather than attached once.
 */
class SilenceBoundedSocket extends net.Socket {
  private readonly onSilence: () => void;

  constructor(silenceMs: number) {
    super();
    this.onSilence = () => {
      log.warn({ silentForMs: silenceMs }, "Database connection went silent, closing it");
      // No error argument: after a TLS upgrade nothing listens for one on this socket, and
      // an unheard 'error' ends the process. The close alone fails the waiting query.
      this.destroy();
    };
    this.setTimeout(silenceMs);
    this.on("timeout", this.onSilence);
  }

  override removeAllListeners(event?: string | symbol): this {
    super.removeAllListeners(event);
    if ((event === undefined || event === "timeout") && this.onSilence) {
      this.on("timeout", this.onSilence);
    }
    return this;
  }
}
