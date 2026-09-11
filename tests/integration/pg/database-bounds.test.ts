import { sql } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase, type DatabaseBounds } from "../../../src/db/connection.js";
import { type PgRelay, startPgRelay } from "../../setup/tcp-relay.js";

const BOUNDS: DatabaseBounds = {
  connectTimeoutSeconds: 2,
  acquireTimeoutSeconds: 5,
  idleTimeoutSeconds: 1,
  maxLifetimeSeconds: 600,
  queryTimeoutSeconds: 2,
};

/** How an await ends within twenty seconds -- long past every bound under test. */
function outcome(pending: Promise<unknown>): Promise<"answered" | "failed" | "hung"> {
  return Promise.race([
    pending.then(
      () => "answered" as const,
      () => "failed" as const,
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000)),
  ]);
}

let relay: PgRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("database client bounds", () => {
  test("a query on a connection that went silent fails within the bound, and the pool recovers", async () => {
    relay = await startPgRelay();
    const db = createDatabase(relay.url, undefined, BOUNDS);
    try {
      await sql`SELECT 1`.execute(db);

      relay.silence(true);
      const started = Date.now();
      expect(await outcome(sql`SELECT 1`.execute(db))).toBe("failed");
      expect(Date.now() - started).toBeLessThan(6_000);

      relay.silence(false);
      expect(await outcome(sql`SELECT 1`.execute(db))).toBe("answered");
    } finally {
      await outcome(db.destroy());
    }
  }, 60_000);
});
