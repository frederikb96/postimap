import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { AccountSync, type AccountState } from "../../../src/sync/account-sync.js";
import type { OutboundProcessor } from "../../../src/sync/outbound.js";
import type { OutboxProcessor } from "../../../src/sync/outbox.js";
import { simplePlainEmail } from "../../factories/mime.js";
import {
  connectImap,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  waitFor,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

afterEach(async () => {
  if (ctx) await teardownE2EContext(ctx);
});

/** Stands in for the shared processors -- this test only exercises start()/stop(). */
function stubProcessor(): OutboundProcessor & OutboxProcessor {
  return {
    subscribeAccount: async () => {},
    unsubscribeAccount: async () => {},
  } as unknown as OutboundProcessor & OutboxProcessor;
}

/** A fresh instance each call, the way a real process restart would create one. */
function makeAccountSync(context: E2EContext): AccountSync {
  return new AccountSync(
    context.accountId,
    context.db,
    {
      SYNC_INTERVAL_SECONDS: 300,
      IDLE_RESTART_SECONDS: 300,
      IMAP_TLS_REJECT_UNAUTHORIZED: false,
      IDLE_FOLDERS: [],
      FULL_TIER_MAX_SKIP_SECONDS: 0,
    },
    getDatabaseUrl(context.schema),
    stubProcessor(),
    stubProcessor(),
  );
}

async function waitForState(accountSync: AccountSync, target: AccountState): Promise<void> {
  await waitFor(() => accountSync.getState() === target, { timeout: 30_000, interval: 300 });
}

describe("E2E: an account restart does not silently swallow mail that arrived meanwhile", () => {
  test("mail delivered between stop() and the next start() still fires message/insert", async () => {
    ctx = await setupE2EContext({ emailPrefix: "e2e-restart", skipImap: true });

    // The account's very first sync -- INBOX has never completed initial_sync_done, so
    // this one is genuinely a backfill and its suppressed events are correct.
    const first = makeAccountSync(ctx);
    await first.start();
    await waitForState(first, "active");
    await first.stop();

    const [folder] = await ctx.pgSql<{ initial_sync_done: boolean }[]>`
      SELECT initial_sync_done FROM folders WHERE id = ${ctx.folderId}
    `;
    expect(folder.initial_sync_done).toBe(true);

    // Mail arrives while the service is down -- nothing here is PostIMAP's doing, and
    // nothing here goes through PG at all.
    const subject = `Arrived while down ${randomUUID().slice(0, 8)}`;
    const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await setupClient.append(
        ctx.folderImapName,
        Buffer.from(simplePlainEmail({ subject })),
        ["\\Seen"],
      );
    } finally {
      await setupClient.logout();
    }

    const received: Record<string, unknown>[] = [];
    const sub = await ctx.pgSql.listen("postimap_events", (payload) => {
      const event = JSON.parse(payload);
      if (event.account_id === ctx.accountId) received.push(event);
    });

    // What a restarted process does: a brand new AccountSync, same account, from scratch.
    const second = makeAccountSync(ctx);
    await second.start();
    await waitForState(second, "active");
    await second.stop();

    // Give the NOTIFY a moment to arrive over the listening connection.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await sub.unlisten();

    const [row] = await ctx.pgSql<{ id: string }[]>`
      SELECT id FROM messages WHERE account_id = ${ctx.accountId} AND subject = ${subject}
    `;
    expect(row).toBeDefined();

    // The mail is mirrored either way -- what backfill mode silences is the event telling
    // a live consumer about it, which is the actual bug.
    const inserts = received.filter((event) => event.type === "message" && event.op === "insert");
    expect(inserts.length).toBeGreaterThan(0);
  });
});
