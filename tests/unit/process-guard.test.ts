import { describe, expect, test, vi } from "vitest";
import {
  handleUncaughtException,
  isHttpClientAssertion,
  isPostgresClosedConnectionWrite,
} from "../../src/util/process-guard.js";

const NULL_WRITE = "Cannot read properties of null (reading 'write')";

/** The shape postgres.js raises when it writes a statement to a connection that has closed. */
function closedConnectionWrite(
  topFrame = "    at Immediate.nextWrite (/app/node_modules/postgres/src/connection.js:255:22)",
  message = NULL_WRITE,
): TypeError {
  const err = new TypeError(message);
  err.stack = [
    `TypeError: ${message}`,
    topFrame,
    "    at process.processImmediate (node:internal/timers:491:21)",
  ].join("\n");
  return err;
}

function assertionError(stack: string[]): Error {
  const err = new Error("The expression evaluated to a falsy value");
  Object.assign(err, { code: "ERR_ASSERTION" });
  err.stack = stack.join("\n");
  return err;
}

/** The shape the HTTP client raises when a peer closes a connection mid-body. */
function httpClientAssertion(): Error {
  return assertionError([
    "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
    "  assert(!this.paused)",
    "    at Parser.finish (node:internal/deps/undici/undici:7388:9)",
    "    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)",
  ]);
}

describe("isHttpClientAssertion", () => {
  test("recognises an assertion raised inside the HTTP client's socket teardown", () => {
    expect(isHttpClientAssertion(httpClientAssertion())).toBe(true);
  });

  test("does not recognise an assertion raised anywhere else", () => {
    const err = assertionError([
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal",
      "    at claimQueueEntry (file:///app/dist/dav/outbound.js:120:5)",
    ]);
    expect(isHttpClientAssertion(err)).toBe(false);
  });

  test("does not recognise an ordinary error, whatever its stack names", () => {
    const err = new Error("socket hang up");
    err.stack =
      "Error: socket hang up\n    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)";
    expect(isHttpClientAssertion(err)).toBe(false);
  });

  test("does not recognise a thrown value that is not an error", () => {
    expect(isHttpClientAssertion("assert(!this.paused) undici")).toBe(false);
    expect(isHttpClientAssertion(undefined)).toBe(false);
  });
});

describe("isPostgresClosedConnectionWrite", () => {
  test("recognises postgres.js writing a statement to a closed connection", () => {
    expect(isPostgresClosedConnectionWrite(closedConnectionWrite())).toBe(true);
    const cjsBuild =
      "    at Immediate.nextWrite (/app/node_modules/postgres/cjs/src/connection.js:250:22)";
    expect(isPostgresClosedConnectionWrite(closedConnectionWrite(cjsBuild))).toBe(true);
  });

  test("does not recognise the same TypeError raised anywhere else", () => {
    const ours = "    at Socket.flush (/app/dist/sync/outbox.js:120:5)";
    const otherDriver = "    at Immediate.nextWrite (/app/node_modules/pg/lib/connection.js:10:3)";
    expect(isPostgresClosedConnectionWrite(closedConnectionWrite(ours))).toBe(false);
    expect(isPostgresClosedConnectionWrite(closedConnectionWrite(otherDriver))).toBe(false);
  });

  test("does not recognise a different TypeError from the same place", () => {
    const err = closedConnectionWrite(
      undefined,
      "Cannot read properties of undefined (reading 'length')",
    );
    expect(isPostgresClosedConnectionWrite(err)).toBe(false);
  });

  test("does not recognise an error of another type with the same message and stack", () => {
    const err = new Error(NULL_WRITE);
    err.stack = closedConnectionWrite().stack;
    expect(isPostgresClosedConnectionWrite(err)).toBe(false);
  });
});

describe("handleUncaughtException", () => {
  test("keeps the process running for the HTTP client's teardown assertion", () => {
    const exit = vi.fn();
    handleUncaughtException(httpClientAssertion(), exit);
    expect(exit).not.toHaveBeenCalled();
  });

  test("keeps the process running for postgres.js writing to a closed connection", () => {
    const exit = vi.fn();
    handleUncaughtException(closedConnectionWrite(), exit);
    expect(exit).not.toHaveBeenCalled();
  });

  test("ends the process for the same TypeError raised outside postgres.js", () => {
    const exit = vi.fn();
    handleUncaughtException(
      closedConnectionWrite("    at Socket.flush (/app/dist/sync/outbox.js:120:5)"),
      exit,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("ends the process for anything else", () => {
    const exit = vi.fn();
    handleUncaughtException(new TypeError("cannot read properties of null"), exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
