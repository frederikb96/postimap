/**
 * Thrown when an in-flight sync operation observes that it has been cancelled
 * (AccountSync.stop() firing its AbortSignal). Distinct from a real sync failure: callers
 * catch it separately so a cancelled sync never gets treated as an error worth retrying --
 * stop() already owns what happens next.
 */
export class SyncAbortedError extends Error {
  constructor() {
    super("Sync aborted");
    this.name = "SyncAbortedError";
  }
}

/** Throws SyncAbortedError if `signal` is set and already aborted. No-op otherwise. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SyncAbortedError();
  }
}
