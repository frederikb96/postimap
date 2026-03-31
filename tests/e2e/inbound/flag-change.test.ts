import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  type E2EContext,
  connectImap,
  deliverAndWait,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-flagchg" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: flag change inbound sync", () => {
  test("external IMAP flag change is reflected in PG after sync", async () => {
    const uniqueSubject = `Flag Test ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Test body for flag change test.",
        auth: { user: ctx.testEmail, pass: ctx.testPassword },
        imapClient: checkClient,
      });
    } finally {
      await checkClient.logout();
    }

    const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);

    const result1 = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(result1.errors).toEqual([]);
    expect(result1.newMessages).toBeGreaterThanOrEqual(1);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const beforeRows = await ctx.pgSql`
      SELECT imap_uid, is_seen, sync_version FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND deleted_at IS NULL
    `;
    expect(beforeRows).toHaveLength(1);
    const beforeSyncVersion = beforeRows[0].sync_version;

    // Change flag via separate IMAP client (+FLAGS \\Seen)
    const flagClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const flagLock = await flagClient.getMailboxLock("INBOX");
      try {
        await flagClient.messageFlagsAdd({ uid: Number(beforeRows[0].imap_uid) }, ["\\Seen"], {
          uid: true,
        });
      } finally {
        flagLock.release();
      }
    } finally {
      await flagClient.logout();
    }

    const result2 = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(result2.errors).toEqual([]);
    expect(result2.updatedFlags).toBeGreaterThanOrEqual(1);

    const afterRows = await ctx.pgSql`
      SELECT is_seen, sync_version FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND deleted_at IS NULL
    `;
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].is_seen).toBe(true);
    expect(Number(afterRows[0].sync_version)).toBeGreaterThan(Number(beforeSyncVersion));
  });
});
