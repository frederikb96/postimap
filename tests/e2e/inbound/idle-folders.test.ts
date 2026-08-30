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
        FULL_TIER_MAX_SKIP_SECONDS: 0,
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
        FULL_TIER_MAX_SKIP_SECONDS: 0,
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

  test("a folder can be switched to push, and switched off again, without a restart", async () => {
    // Which folders are worth an IDLE connection is a per-account choice that changes at
    // runtime, so it is a column a consumer writes -- not a config value needing a deploy.
    ctx = await setupE2EContext({ emailPrefix: "e2e-idle-setting", skipImap: true });

    const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await setupClient.mailboxCreate("Work");
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
        FULL_TIER_MAX_SKIP_SECONDS: 0,
        IDLE_FOLDERS: ["INBOX"],
      },
      getDatabaseUrl(ctx.schema),
      stubProcessor(),
      stubProcessor(),
    );

    try {
      await accountSync.start();
      await waitForActive(accountSync);

      // The configured default seeded INBOX, and every other folder got an honest 'off'
      // rather than a NULL that would read as "not looked at yet".
      const seeded = await ctx.pgSql<{ imap_name: string; idle_status: string }[]>`
        SELECT imap_name, idle_status FROM folders
        WHERE account_id = ${ctx.accountId} ORDER BY imap_name
      `;
      const statusOf = (name: string) => seeded.find((f) => f.imap_name === name)?.idle_status;
      expect(statusOf("INBOX")).toBe("watching");
      expect(statusOf("Work")).toBe("off");

      // The consumer's write: push Work, stop pushing INBOX.
      await ctx.pgSql`
        UPDATE folders SET idle_requested = (imap_name = 'Work')
        WHERE account_id = ${ctx.accountId}
      `;
      await accountSync.requestSync();

      expect(accountSync.getIdleFolderCount()).toBe(1);
      const after = await ctx.pgSql<{ imap_name: string; idle_status: string }[]>`
        SELECT imap_name, idle_status FROM folders
        WHERE account_id = ${ctx.accountId} ORDER BY imap_name
      `;
      const afterStatus = (name: string) => after.find((f) => f.imap_name === name)?.idle_status;
      expect(afterStatus("Work")).toBe("watching");
      // And the default does not creep back: idle_status is no longer NULL for INBOX, which
      // is what stops config re-seeding a preference the consumer has since changed.
      expect(afterStatus("INBOX")).toBe("off");
    } finally {
      await accountSync.stop();
    }
  });
});
