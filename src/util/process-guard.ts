import { createLogger } from "./logger.js";

const log = createLogger("process-guard");

/**
 * Whether an error is an assertion raised inside the HTTP client while it tears down a
 * socket.
 *
 * The HTTP client bundled with Node 24 asserts that its response parser is not paused
 * when the peer closes the connection. A response body large enough to fill the parser's
 * buffer before the caller reads it pauses the parser under backpressure, so a server
 * that closes rather than keeping the connection alive can reach that assertion. It is
 * raised from the socket's own `end` listener -- outside any promise chain, so the
 * request's caller cannot catch it, and outside every `try` in this service.
 */
export function isHttpClientAssertion(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as { code?: unknown }).code !== "ERR_ASSERTION") return false;
  return (err.stack ?? "").includes("undici");
}

/**
 * Decide what an uncaught exception does. Anything unrecognised ends the process, since
 * nothing here knows what state it left behind. The HTTP-client assertion above belongs
 * to a single request, which fails on its own request timeout and is reported on the
 * collection or account that issued it, so the rest of the service keeps running.
 */
export function handleUncaughtException(err: unknown, exit: (code: number) => void): void {
  if (isHttpClientAssertion(err)) {
    log.error({ err }, "HTTP client assertion during socket teardown, request abandoned");
    return;
  }
  log.fatal({ err }, "Uncaught exception");
  exit(1);
}

export function installProcessGuards(): void {
  process.on("uncaughtException", (err) => {
    handleUncaughtException(err, (code) => process.exit(code));
  });
}
