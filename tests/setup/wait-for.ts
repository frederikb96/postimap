import type postgres from "postgres";

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
}

/**
 * Poll `fn` until it returns a truthy value or the timeout expires.
 */
export async function waitFor<T>(fn: () => T | Promise<T>, opts: WaitForOptions = {}): Promise<T> {
  const { timeout = 5_000, interval = 100 } = opts;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/**
 * LISTEN on a PG channel and resolve on the first NOTIFY payload.
 */
export async function waitForNotify(
  sql: postgres.Sql,
  channel: string,
  timeout = 5_000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let unlisten: (() => Promise<void>) | undefined;

    const timer = setTimeout(() => {
      unlisten?.().catch(() => {});
      reject(new Error(`waitForNotify("${channel}") timed out after ${timeout}ms`));
    }, timeout);

    sql
      .listen(channel, (payload) => {
        clearTimeout(timer);
        unlisten?.().catch(() => {});
        resolve(payload);
      })
      .then((unlistenFn) => {
        unlisten = unlistenFn;
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
