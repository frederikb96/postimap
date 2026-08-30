import { afterEach, describe, expect, test } from "vitest";
import { AccountSync } from "../../../src/sync/account-sync.js";
import type { OutboundProcessor } from "../../../src/sync/outbound.js";
import type { OutboxProcessor } from "../../../src/sync/outbox.js";
import { simplePlainEmail } from "../../factories/mime.js";
import {
  connectImap,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
} from "../../setup/e2e-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

let ctx: E2EContext;

afterEach(async () => {
  if (ctx) await teardownE2EContext(ctx);
});

/** Stands in for the shared processors -- this test only exercises the sync cycle. */
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

describe("E2E: a folder created elsewhere is picked up without restarting the account", () => {
  test("periodic sync discovers a new folder and backfills it", async () => {
    ctx = await setupE2EContext({ emailPrefix: "e2e-folder-discovery", skipImap: true });

    const accountSync = new AccountSync(
      ctx.accountId,
      ctx.db,
      {
        SYNC_INTERVAL_SECONDS: 1,
        IDLE_RESTART_SECONDS: 300,
        IMAP_TLS_REJECT_UNAUTHORIZED: false,
        IDLE_FOLDERS: [],
      },
      getDatabaseUrl(ctx.schema),
      stubProcessor(),
      stubProcessor(),
    );

    try {
      await accountSync.start();
      await waitForActive(accountSync);

      // The folder does not exist yet at the one moment discovery used to run, so
      // finding it later is only possible if the sync cycle re-LISTs.
      const [before] = await ctx.pgSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM folders
        WHERE account_id = ${ctx.accountId} AND imap_name = 'Later'
      `;
      expect(before.n).toBe(0);

      const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
      try {
        await setupClient.mailboxCreate("Later");
        await setupClient.append(
          "Later",
          Buffer.from(simplePlainEmail({ subject: "Arrived in a new folder" })),
          ["\\Seen"],
        );
      } finally {
        await setupClient.logout();
      }

      const folder = await waitFor(
        async () => {
          const rows = await ctx.pgSql<{ id: string; initial_sync_done: boolean }[]>`
            SELECT id, initial_sync_done FROM folders
            WHERE account_id = ${ctx.accountId} AND imap_name = 'Later' AND deleted_at IS NULL
          `;
          // initial_sync_done is what separates a discovered folder from a synced one:
          // the row appearing first and the backfill landing later is a real interleaving.
          return rows[0]?.initial_sync_done ? rows[0] : null;
        },
        { timeout: 30_000, interval: 500 },
      );

      const [message] = await ctx.pgSql<{ subject: string }[]>`
        SELECT subject FROM messages WHERE folder_id = ${folder.id}
      `;
      expect(message?.subject).toBe("Arrived in a new folder");
    } finally {
      await accountSync.stop();
    }
  });
});
