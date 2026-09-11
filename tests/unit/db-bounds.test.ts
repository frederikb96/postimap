import type postgres from "postgres";
import { describe, expect, test, vi } from "vitest";
import { guardReservations } from "../../src/db/connection.js";

/** A stand-in postgres.js instance whose reserve() hands out connections on demand. */
function fakePool() {
  const waiting: ((reserved: postgres.ReservedSql) => void)[] = [];
  const pool = Object.assign(() => undefined, {
    reserve: () =>
      new Promise<postgres.ReservedSql>((resolve) => {
        waiting.push(resolve);
      }),
  });
  return {
    pg: pool as unknown as postgres.Sql,
    /** Hand the next waiting reserve() a connection whose queries all end in `outcome`. */
    hand: (outcome: () => Promise<unknown> = async () => []) => {
      const release = vi.fn();
      waiting.shift()?.({ release, unsafe: () => outcome() } as unknown as postgres.ReservedSql);
      return release;
    },
  };
}

describe("guardReservations", () => {
  test("gives up waiting for a pooled connection after the bound", async () => {
    const { pg } = fakePool();
    const started = Date.now();

    await expect(guardReservations(pg, 50).reserve()).rejects.toThrow(
      /No database connection became free within 50 ms/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("passes a connection through when one is free in time", async () => {
    const { pg, hand } = fakePool();
    const reserving = guardReservations(pg, 1_000).reserve();
    const release = hand();

    const reserved = await reserving;
    await reserved.unsafe("SELECT 1");
    reserved.release();
    expect(release).toHaveBeenCalledOnce();
  });

  test("a connection arriving after its caller gave up goes straight back to the pool", async () => {
    const { pg, hand } = fakePool();
    await expect(guardReservations(pg, 20).reserve()).rejects.toThrow();

    const release = hand();
    await new Promise((resolve) => setImmediate(resolve));

    expect(release).toHaveBeenCalledOnce();
  });

  test.each([
    [
      "closed under it",
      Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" }),
    ],
    [
      "reset by the peer",
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
    ],
  ])("a connection %s is never handed back to the pool", async (_, lost) => {
    const { pg, hand } = fakePool();
    const reserving = guardReservations(pg, 1_000).reserve();
    const release = hand(() => Promise.reject(lost));
    const reserved = await reserving;

    await expect(reserved.unsafe("SELECT 1")).rejects.toBe(lost);
    reserved.release();

    expect(release).not.toHaveBeenCalled();
  });

  test("a query the server refused leaves its connection in the pool", async () => {
    const { pg, hand } = fakePool();
    const reserving = guardReservations(pg, 1_000).reserve();
    const refused = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const release = hand(() => Promise.reject(refused));
    const reserved = await reserving;

    await expect(reserved.unsafe("INSERT ...")).rejects.toBe(refused);
    reserved.release();

    expect(release).toHaveBeenCalledOnce();
  });
});
