import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../src/sync/inbound.js";
import {
  type E2EContext,
  connectImap,
  deliverTestEmail,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
  waitFor,
} from "../setup/e2e-helpers.js";

let ctx: E2EContext;
const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "prop-loop" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("Property: loop bounded", () => {
  test("flag change generates at most 1 sync_queue entry per flag (no infinite loop)", async () => {
    const uniqueSubject = `LoopBound ${suffix}`;
    await deliverTestEmail({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject: uniqueSubject,
      text: "Body for loop bound test.",
      auth: { user: ctx.testEmail, pass: ctx.testPassword },
    });

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await waitFor(
      async () => {
        const lock = await checkClient.getMailboxLock("INBOX");
        try {
          return checkClient.mailbox && checkClient.mailbox.exists > 0;
        } finally {
          lock.release();
        }
      },
      { timeout: 10_000, interval: 500 },
    );
    await checkClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    await inbound.fullSync(ctx.folderId, "INBOX");

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const msgRows = await ctx.pgSql`
      SELECT id FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND deleted_at IS NULL
    `;
    expect(msgRows).toHaveLength(1);
    const msgId = msgRows[0].id;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("\\Seen", "\\Flagged", "\\Answered", "\\Draft"),
        async (flag) => {
          await ctx.pgSql`DELETE FROM sync_queue WHERE message_id = ${msgId}`;

          const flagCol =
            flag === "\\Seen"
              ? "is_seen"
              : flag === "\\Flagged"
                ? "is_flagged"
                : flag === "\\Answered"
                  ? "is_answered"
                  : "is_draft";

          await ctx.pgSql.unsafe(
            `UPDATE messages SET ${flagCol} = NOT ${flagCol} WHERE id = '${msgId}'`,
          );

          const queueEntries = await ctx.pgSql`
            SELECT id, action, payload FROM sync_queue
            WHERE message_id = ${msgId} AND status = 'pending'
          `;

          const entriesForThisFlag = queueEntries.filter((e) => {
            const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
            return payload.flag === flag;
          });

          expect(entriesForThisFlag.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 8, endOnFailure: true },
    );
  });
});
