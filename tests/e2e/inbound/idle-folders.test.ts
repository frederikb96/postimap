import { afterEach, describe, expect, test } from "vitest";
import { AccountSync } from "../../../src/sync/account-sync.js";
import type { OutboundProcessor } from "../../../src/sync/outbound.js";
import type { OutboxProcessor } from "../../../src/sync/outbox.js";
import {
  connectImap,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

afterEach(async () => {
  if (ctx) await teardownE2EContext(ctx);
});

/** Stands in for the shared processors -- this test only exercises account startup. */
function stubProcessor(): OutboundProcessor & OutboxProcessor {
  return {
    subscribeAccount: async () => {},
    unsubscribeAccount: async () => {},
  } as unknown as OutboundProcessor & OutboxProcessor;
}

async function waitForActive(accountSync: AccountSync): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      const state = accountSync.getState();
      if (state === "active") {
        clearInterval(poll);
        resolve();
      } else if (state === "error" || Date.now() - start > 30_000) {
        clearInterval(poll);
        reject(new Error(`Account did not become active in time (state=${state})`));
      }
    }, 300);
  });
}

describe("E2E: sync.idle_folders bounds IDLE connections", () => {
  test("an account with several folders opens only as many IDLE connections as idle_folders lists", async () => {
    ctx = await setupE2EContext({ emailPrefix: "e2e-idle-bound", skipImap: true });

    // Three folders total (INBOX from setupE2EContext + two more created directly on the
    // server); a pre-bound IdleWatcher opened one connection per folder here.
    const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await setupClient.mailboxCreate("Work");
      await setupClient.mailboxCreate("Personal");
    } finally {
      await setupClient.logout();
    }

    const accountSync = new AccountSync(
      ctx.accountId,
      ctx.db,
      {
        SYNC_INTERVAL_SECONDS: 300,
        IDLE_RESTART_SECONDS: 300,
        IMAP_TLS_REJECT_UNAUTHORIZED: false,
        IDLE_FOLDERS: ["INBOX"],
      },
      getDatabaseUrl(ctx.schema),
      stubProcessor(),
      stubProcessor(),
    );

    try {
      await accountSync.start();
      await waitForActive(accountSync);

      const folderCount = await ctx.pgSql`
        SELECT count(*)::int AS n FROM folders WHERE account_id = ${ctx.accountId}
      `;
      expect(folderCount[0].n).toBeGreaterThanOrEqual(3);

      // The bound: three folders exist, idle_folders names exactly one.
      expect(accountSync.getIdleFolderCount()).toBe(1);
    } finally {
      await accountSync.stop();
    }
  });

  test("idle_folders names not present on the account are ignored, not errored", async () => {
    ctx = await setupE2EContext({ emailPrefix: "e2e-idle-missing", skipImap: true });

    const accountSync = new AccountSync(
      ctx.accountId,
      ctx.db,
      {
        SYNC_INTERVAL_SECONDS: 300,
        IDLE_RESTART_SECONDS: 300,
        IMAP_TLS_REJECT_UNAUTHORIZED: false,
        IDLE_FOLDERS: ["INBOX", "DoesNotExist"],
      },
      getDatabaseUrl(ctx.schema),
      stubProcessor(),
      stubProcessor(),
    );

    try {
      await accountSync.start();
      await waitForActive(accountSync);

      expect(accountSync.getState()).toBe("active");
      expect(accountSync.getIdleFolderCount()).toBe(1);
    } finally {
      await accountSync.stop();
    }
  });
});
