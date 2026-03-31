import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ImapClient } from "../../src/imap/pool.js";
import { InboundSync } from "../../src/sync/inbound.js";
import {
  type E2EContext,
  appendBulkMessages,
  connectImap,
  env,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
  testTls,
} from "../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "prop-idemp", skipImap: true });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("Property: idempotency", () => {
  test("running sync twice produces no changes on second run", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.subarray(["\\Seen", "\\Flagged", "\\Answered", "\\Draft"], {
          minLength: 0,
          maxLength: 4,
        }),
        async (msgCount, flags) => {
          await ctx.pgSql`DELETE FROM messages WHERE folder_id = ${ctx.folderId}`;

          // Use a fresh IMAP connection for cleanup and seeding
          const setupClient = await connectImap({
            user: ctx.testEmail,
            password: ctx.testPassword,
          });
          try {
            const lock = await setupClient.getMailboxLock("INBOX");
            try {
              const uids = await setupClient.search({ all: true }, { uid: true });
              if (uids && uids.length > 0) {
                await setupClient.messageDelete(uids.map(String).join(","), { uid: true });
              }
            } finally {
              lock.release();
            }

            await appendBulkMessages(setupClient, "INBOX", msgCount, flags);
          } finally {
            await setupClient.logout();
          }

          // Fresh ImapClient per iteration avoids stale mailbox state
          const syncClient = new ImapClient({
            host: env.IMAP_HOST,
            port: env.IMAP_PORT,
            user: ctx.testEmail,
            password: ctx.testPassword,
            tls: testTls,
            retry: { maxRetries: 0, baseDelay: 100 },
          });
          syncClient.on("error", () => {});
          await syncClient.connect();

          try {
            const inbound = new InboundSync(syncClient, ctx.db, ctx.accountId, testCapabilities);
            const firstResult = await inbound.fullSync(ctx.folderId, "INBOX");
            expect(firstResult.errors).toEqual([]);
            expect(firstResult.newMessages).toBe(msgCount);

            const snapshotAfterFirst = await ctx.pgSql`
              SELECT imap_uid, is_seen, is_flagged, is_answered, is_draft, sync_version
              FROM messages
              WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
              ORDER BY imap_uid
            `;

            const secondResult = await inbound.syncFolder(ctx.folderId, "INBOX");
            expect(secondResult.errors).toEqual([]);
            expect(secondResult.newMessages).toBe(0);
            expect(secondResult.updatedFlags).toBe(0);
            expect(secondResult.deletedMessages).toBe(0);

            const snapshotAfterSecond = await ctx.pgSql`
              SELECT imap_uid, is_seen, is_flagged, is_answered, is_draft, sync_version
              FROM messages
              WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
              ORDER BY imap_uid
            `;

            expect(snapshotAfterSecond).toEqual(snapshotAfterFirst);
          } finally {
            await syncClient.disconnect();
          }
        },
      ),
      { numRuns: 3, endOnFailure: true },
    );
  });
});
