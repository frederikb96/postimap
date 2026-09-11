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
 * Whether an error is postgres.js writing a statement to a connection that has closed.
 *
 * A connection a transaction holds between its statements can close while idle -- a server
 * restart, a failover -- and stays attached to that transaction. Its next statement is then
 * written to the missing socket from a timer, so the TypeError lands outside any promise and
 * the statement never settles. Only that TypeError, raised from postgres.js's own write, is
 * recognised; the same message from anywhere else is an ordinary bug.
 */
export function isPostgresClosedConnectionWrite(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  if (err.message !== "Cannot read properties of null (reading 'write')") return false;
  const topFrame = (err.stack ?? "").split("\n").find((line) => line.trimStart().startsWith("at "));
  if (!topFrame?.includes("nextWrite")) return false;
  return /[\\/]node_modules[\\/]postgres[\\/](cjs[\\/])?src[\\/]connection\.js:/.test(topFrame);
}

/**
 * Decide what an uncaught exception does. Anything unrecognised ends the process, since
 * nothing here knows what state it left behind. The two recognised errors each belong to
 * one request or statement:
 * - The HTTP-client assertion fails its own request on the request timeout, reported on
 *   the collection or account that issued it.
 * - The postgres.js write leaves its statement unsettled. The batch waiting on it is
 *   abandoned by its processor's watchdog, and the connection stays out of the pool until
 *   restart.
 */
export function handleUncaughtException(err: unknown, exit: (code: number) => void): void {
  if (isHttpClientAssertion(err)) {
    log.error({ err }, "HTTP client assertion during socket teardown, request abandoned");
    return;
  }
  if (isPostgresClosedConnectionWrite(err)) {
    log.error({ err }, "Database statement written to a closed connection, statement abandoned");
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
