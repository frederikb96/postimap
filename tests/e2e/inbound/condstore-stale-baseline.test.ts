import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  connectImap,
  deliverAndWait,
  type E2EContext,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
  waitFor,
} from "../../setup/e2e-helpers.js";

/**
 * Forces the CONDSTORE tier against Dovecot, which also advertises QRESYNC -- only tier
 * SELECTION differs here, the underlying connection still has both extensions enabled.
 */
const CONDSTORE_ONLY = { ...testCapabilities, qresync: false };

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-condstore-baseline" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

/**
 * Covers the CONDSTORE flag-sync path against a real server with the connection left open
 * across cycles -- getMailboxLock()'s fast path then never reselects (see inbound.ts), so
 * this is the one scenario among the existing CONDSTORE/QRESYNC e2e coverage that does not
 * reconnect between cycles to force a fresh SELECT. ImapFlow updates the client's cached
 * HIGHESTMODSEQ from ordinary FETCH responses on its own, which is what keeps this green
 * even on top of the pre-fix change-detector.ts/inbound.ts -- the regression this guards
 * against is change-detector.ts relying on that one unconfirmed assumption instead of
 * tracking (and persisting) the baseline itself; see the unit tests in
 * change-detector.test.ts and the PG-integration test in update-flags-noop.test.ts for
 * coverage that does turn red against the pre-fix code.
 */
describe("E2E: CONDSTORE modseq baseline survives a connection that stays open across cycles", () => {
  test("a flag change is reported once, not redelivered on every later cycle", async () => {
    const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, CONDSTORE_ONLY);

    const subject = `Condstore Baseline ${randomUUID().slice(0, 8)}`;
    const rawClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject,
        text: "Baseline body.",
        imapClient: rawClient,
      });
    } finally {
      await rawClient.logout();
    }

    // Initial sync -- the first-ever SELECT of INBOX on this connection, so it always sees
    // the delivered message (a fresh SELECT does a full resync; there is no staleness to
    // race against yet). This also establishes the folder's first modseq baseline.
    const initial = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(initial.errors).toEqual([]);
    expect(initial.newMessages).toBe(1);

    const rows = await ctx.pgSql`
      SELECT imap_uid FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${subject} AND expunged_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    const targetUid = Number(rows[0].imap_uid);

    const baselineAfterInitial = await ctx.pgSql`
      SELECT highestmodseq FROM folders WHERE id = ${ctx.folderId}
    `;

    const flagClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const lock = await flagClient.getMailboxLock("INBOX");
      try {
        await flagClient.messageFlagsAdd({ uid: targetUid }, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await flagClient.logout();
    }

    // Wait for ctx.imapClient's own session to notice the external flag change -- an
    // already-open session can lag a moment behind a change made on a different
    // connection, same reasoning as deliverAndWait() for new mail. This is just waiting
    // for the change to become visible, not working around the bug under test: production
    // has whole sync-interval seconds between cycles for exactly this to settle.
    await waitFor(
      async () => {
        const lock = await ctx.imapClient.getMailboxLock("INBOX");
        try {
          const msg = await ctx.imapClient.client.fetchOne(
            String(targetUid),
            { flags: true },
            { uid: true },
          );
          return msg?.flags?.has("\\Seen");
        } finally {
          lock.release();
        }
      },
      { timeout: 10_000, interval: 200 },
    );

    // Deliberately no disconnect/reconnect of ctx.imapClient anywhere in this test --
    // INBOX stays open on this connection from the initial sync above, so getMailboxLock()
    // takes its fast path (see inbound.ts) and never reselects the folder again.
    const afterFlag = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(afterFlag.errors).toEqual([]);
    expect(afterFlag.updatedFlags).toBe(1);

    // The stored baseline must have moved past what the flag change itself reported.
    const baselineAfterFlag = await ctx.pgSql`
      SELECT highestmodseq FROM folders WHERE id = ${ctx.folderId}
    `;
    expect(baselineAfterFlag[0].highestmodseq).not.toBe(baselineAfterInitial[0].highestmodseq);

    // Nothing changed since -- a correctly-advanced baseline reports no further changes.
    // A baseline stuck behind the flag change above would redeliver it on every cycle from
    // here on, forever.
    const stable = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(stable.errors).toEqual([]);
    expect(stable.updatedFlags).toBe(0);
  }, 30_000);
});
