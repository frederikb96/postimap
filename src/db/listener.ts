import type { Subscriber } from "pg-listen";
import { createLogger } from "../util/logger.js";

const log = createLogger("pg-listener");

// Re-export for consumers
export type { Subscriber } from "pg-listen";

type CreateSubscriberFn = (
  config: { connectionString: string },
  options?: Record<string, unknown>,
) => Subscriber;

/**
 * Thin wrapper around pg-listen for LISTEN/NOTIFY subscription.
 * pg-listen handles auto-reconnect out of the box.
 */
export async function createPgListener(databaseUrl: string): Promise<Subscriber> {
  // Dynamic import to handle CJS default export correctly with NodeNext resolution
  const mod = await import("pg-listen");
  const resolved = typeof mod.default === "function" ? mod.default : mod;
  const createSubscriber = resolved as unknown as CreateSubscriberFn;

  const subscriber = createSubscriber(
    { connectionString: databaseUrl },
    {
      retryInterval: (attempt: number) => Math.min(500 * 2 ** attempt, 30_000),
      retryTimeout: Number.POSITIVE_INFINITY,
    },
  );

  subscriber.events.on("connected", () => {
    log.info("PG LISTEN connection established");
  });

  subscriber.events.on("reconnect", (attempt: number) => {
    log.info({ attempt }, "PG LISTEN reconnecting");
  });

  subscriber.events.on("error", (error: Error) => {
    log.error({ err: error }, "PG LISTEN connection error");
  });

  return subscriber;
}
