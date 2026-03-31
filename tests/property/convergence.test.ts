import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../src/sync/inbound.js";
import {
  type E2EContext,
  connectImap,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../setup/e2e-helpers.js";

let ctx: E2EContext;
const suffix = randomUUID().slice(0, 8);
const IMAP_FLAGS = ["\\Seen", "\\Flagged", "\\Answered", "\\Draft"];

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "prop-conv" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("Property: convergence", () => {
  test("after random flag operations, PG and IMAP converge to same state", async () => {
    const rawMsg = Buffer.from(
      `From: prop@test.local\r\nTo: ${ctx.testEmail}\r\nSubject: Convergence Test\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <conv-${suffix}@test.local>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nConvergence body\r\n`,
    );

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await directClient.append("INBOX", rawMsg, []);
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const initialResult = await inbound.fullSync(ctx.folderId, "INBOX");
    expect(initialResult.errors).toEqual([]);
    expect(initialResult.newMessages).toBe(1);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const msgRow = await ctx.pgSql`
      SELECT imap_uid FROM messages
      WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
      LIMIT 1
    `;
    const uid = Number(msgRow[0].imap_uid);

    const arbFlagOp = fc.record({
      flag: fc.constantFrom(...IMAP_FLAGS),
      action: fc.constantFrom("add" as const, "remove" as const),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(arbFlagOp, { minLength: 1, maxLength: 8 }), async (ops) => {
        const lock = await ctx.imapClient.getMailboxLock("INBOX");
        try {
          for (const op of ops) {
            if (op.action === "add") {
              await ctx.imapClient.client.messageFlagsAdd(String(uid), [op.flag], { uid: true });
            } else {
              await ctx.imapClient.client.messageFlagsRemove(String(uid), [op.flag], { uid: true });
            }
          }
        } finally {
          lock.release();
        }

        const syncResult = await inbound.syncFolder(ctx.folderId, "INBOX");
        expect(syncResult.errors).toEqual([]);

        const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
        let imapFlags: Set<string> = new Set();
        try {
          const checkLock = await checkClient.getMailboxLock("INBOX");
          try {
            for await (const msg of checkClient.fetch(
              String(uid),
              { uid: true, flags: true },
              { uid: true },
            )) {
              if (msg.uid === uid) {
                imapFlags = msg.flags ?? new Set();
              }
            }
          } finally {
            checkLock.release();
          }
        } finally {
          await checkClient.logout();
        }

        const pgMsg = await ctx.pgSql`
            SELECT is_seen, is_flagged, is_answered, is_draft, is_deleted
            FROM messages
            WHERE folder_id = ${ctx.folderId} AND imap_uid = ${String(uid)} AND deleted_at IS NULL
          `;
        expect(pgMsg).toHaveLength(1);

        expect(pgMsg[0].is_seen).toBe(imapFlags.has("\\Seen"));
        expect(pgMsg[0].is_flagged).toBe(imapFlags.has("\\Flagged"));
        expect(pgMsg[0].is_answered).toBe(imapFlags.has("\\Answered"));
        expect(pgMsg[0].is_draft).toBe(imapFlags.has("\\Draft"));
      }),
      { numRuns: 5, endOnFailure: true },
    );
  });
});
