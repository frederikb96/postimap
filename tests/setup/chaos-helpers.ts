import { type Proxy as ToxiProxy, Toxiproxy } from "toxiproxy-node-client";
import { env } from "./env.js";

export type { ToxiProxy };

export interface ChaosContext {
  toxiproxy: Toxiproxy;
  available: boolean;
}

export async function createToxiproxyClient(): Promise<ChaosContext> {
  const toxiproxy = new Toxiproxy(`http://${env.TOXIPROXY_HOST}:${env.TOXIPROXY_PORT}`);
  try {
    await toxiproxy.getAll();
    return { toxiproxy, available: true };
  } catch {
    return { toxiproxy, available: false };
  }
}

export async function createImapProxy(
  toxiproxy: Toxiproxy,
  name: string,
  listenPort: number,
): Promise<ToxiProxy> {
  return toxiproxy.createProxy({
    name,
    listen: `0.0.0.0:${listenPort}`,
    upstream: env.TOXIPROXY_IMAP_UPSTREAM,
  });
}
