import { sql } from "kysely";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DatabaseBounds } from "../../../src/db/connection.js";
import {
  handleUncaughtException,
  isPostgresClosedConnectionWrite,
} from "../../../src/util/process-guard.js";
import { type PgRelay, startPgRelay } from "../../setup/tcp-relay.js";

const BOUNDS: DatabaseBounds = {
  connectTimeoutSeconds: 2,
  acquireTimeoutSeconds: 5,
  idleTimeoutSeconds: 1,
  maxLifetimeSeconds: 600,
  queryTimeoutSeconds: 2,
};

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

let relay: PgRelay | undefined;

afterEach(async () => {
  process.setUncaughtExceptionCaptureCallback(null);
  await relay?.close();
  relay = undefined;
});

describe("a transaction's connection closing between two of its statements", () => {
  test("postgres.js throws outside any promise, and the process guard survives it", async () => {
    relay = await startPgRelay();
    const db = createDatabase(relay.url, undefined, BOUNDS);
    // Uncaught exceptions come here instead of ending the test run, so the real error can be
    // handed to the guard exactly as production would hand it over.
    const uncaught = new Promise<unknown>((resolve) =>
      process.setUncaughtExceptionCaptureCallback(resolve),
    );

    // The second statement never settles once its connection is gone -- what the batch
    // watchdogs exist to absorb -- so nothing here waits on it.
    const cut = relay.cut;
    void db
      .transaction()
      .execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        cut();
        await resolveAfter(300, undefined);
        await sql`SELECT 1`.execute(trx);
      })
      .catch(() => {});

    const err = await Promise.race([uncaught, resolveAfter(10_000, "nothing was thrown")]);
    expect(err).toBeInstanceOf(TypeError);
    expect(isPostgresClosedConnectionWrite(err)).toBe(true);

    const exit = vi.fn();
    handleUncaughtException(err, exit);
    expect(exit).not.toHaveBeenCalled();

    await Promise.race([db.destroy(), resolveAfter(5_000, undefined)]);
  }, 30_000);
});
