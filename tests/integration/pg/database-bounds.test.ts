import * as net from "node:net";
import { sql } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase, type DatabaseBounds } from "../../../src/db/connection.js";
import { env } from "../../setup/env.js";

const BOUNDS: DatabaseBounds = {
  connectTimeoutSeconds: 2,
  acquireTimeoutSeconds: 5,
  idleTimeoutSeconds: 1,
  maxLifetimeSeconds: 600,
  queryTimeoutSeconds: 2,
};

interface Relay {
  port: number;
  /** Swallow everything either side sends, holding every connection open. */
  silence(on: boolean): void;
  close(): Promise<void>;
}

/**
 * A TCP relay to the test PostgreSQL. Silenced, it is what a peer that vanished behind a
 * proxy or NAT leaves: the client's socket stays up, its keepalive probes are answered by
 * the relay, and no reply ever comes.
 */
async function startRelay(): Promise<Relay> {
  let silent = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(env.PG_PORT, env.PG_HOST);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (chunk) => {
      if (!silent) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!silent) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    silence: (on) => {
      silent = on;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** How an await ends within twenty seconds -- long past every bound under test. */
function outcome(pending: Promise<unknown>): Promise<"answered" | "failed" | "hung"> {
  return Promise.race([
    pending.then(
      () => "answered" as const,
      () => "failed" as const,
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000)),
  ]);
}

let relay: Relay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("database client bounds", () => {
  test("a query on a connection that went silent fails within the bound, and the pool recovers", async () => {
    relay = await startRelay();
    const db = createDatabase(
      `postgresql://${env.PG_USER}:${env.PG_PASSWORD}@127.0.0.1:${relay.port}/${env.PG_DATABASE}`,
      undefined,
      BOUNDS,
    );
    try {
      await sql`SELECT 1`.execute(db);

      relay.silence(true);
      const started = Date.now();
      expect(await outcome(sql`SELECT 1`.execute(db))).toBe("failed");
      expect(Date.now() - started).toBeLessThan(6_000);

      relay.silence(false);
      expect(await outcome(sql`SELECT 1`.execute(db))).toBe("answered");
    } finally {
      await outcome(db.destroy());
    }
  }, 60_000);
});
