import { describe, expect, test, vi } from "vitest";
import { handleUncaughtException, isHttpClientAssertion } from "../../src/util/process-guard.js";

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

describe("handleUncaughtException", () => {
  test("keeps the process running for the HTTP client's teardown assertion", () => {
    const exit = vi.fn();
    handleUncaughtException(httpClientAssertion(), exit);
    expect(exit).not.toHaveBeenCalled();
  });

  test("ends the process for anything else", () => {
    const exit = vi.fn();
    handleUncaughtException(new TypeError("cannot read properties of null"), exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
