import { type Proxy as ToxiProxy, Toxiproxy } from "toxiproxy-node-client";
import { env } from "./env.js";

export type { ToxiProxy };

export interface ChaosContext {
  toxiproxy: Toxiproxy;
}

/**
 * Global setup starts a Toxiproxy container for every project that names it, chaos
 * included, so reaching it here is not optional -- a connection failure means the chaos
 * suite's own environment is broken, not that Toxiproxy is a maybe-present dependency to
 * skip around. Left unswallowed, it fails every test in the file up front rather than
 * skipping them, which is indistinguishable from them having passed.
 */
export async function createToxiproxyClient(): Promise<ChaosContext> {
  const toxiproxy = new Toxiproxy(`http://${env.TOXIPROXY_HOST}:${env.TOXIPROXY_PORT}`);
  await toxiproxy.getAll();
  return { toxiproxy };
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
