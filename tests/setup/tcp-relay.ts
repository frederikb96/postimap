import * as net from "node:net";
import { env } from "./env.js";

export interface PgRelay {
  /** The test database, reached through this relay. */
  url: string;
  /** Swallow everything either side sends, holding every connection open. */
  silence(on: boolean): void;
  /** Close every relayed connection from the server's side, as a restart or failover does. */
  cut(): void;
  close(): Promise<void>;
}

/**
 * A TCP relay to the test PostgreSQL. Silenced, it is what a peer that vanished behind a
 * proxy or NAT leaves: the client's socket stays up, its keepalive probes are answered by
 * the relay, and no reply ever comes. Cut, it is the server going away mid-session.
 */
export async function startPgRelay(): Promise<PgRelay> {
  let silent = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(env.PG_PORT, env.PG_HOST);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
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
  const port = (server.address() as net.AddressInfo).port;

  const destroyAll = () => {
    for (const socket of [...sockets]) socket.destroy();
  };

  return {
    url: `postgresql://${env.PG_USER}:${env.PG_PASSWORD}@127.0.0.1:${port}/${env.PG_DATABASE}`,
    silence: (on) => {
      silent = on;
    },
    cut: destroyAll,
    close: () => {
      destroyAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
