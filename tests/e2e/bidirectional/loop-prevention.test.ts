import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  type E2EContext,
  connectImap,
  deliverAndWait,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-loop" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: bidirectional loop prevention", () => {
  test("PG -> IMAP -> PG loop: flag set in PG, synced to IMAP, inbound does NOT re-enqueue", async () => {
    const uniqueSubject = `Loop Test ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Body for loop prevention test.",
        auth: { user: ctx.testEmail, pass: ctx.testPassword },
        imapClient: checkClient,
      });
    } finally {
      await checkClient.logout();
    }

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const initialSync = await inbound.syncFolder(ctx.folderId, "INBOX");
    expect(initialSync.errors).toEqual([]);
    expect(initialSync.newMessages).toBeGreaterThanOrEqual(1);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const msgRows = await ctx.pgSql`
      SELECT id, imap_uid, is_seen, sync_version
      FROM messages WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND deleted_at IS NULL
    `;
    expect(msgRows).toHaveLength(1);
    const msgId = msgRows[0].id;
    const syncVersionAfterInbound = Number(msgRows[0].sync_version);

    // App sets is_seen=true in PG (trigger fires -> sync_queue entry)
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;

    const queueAfterAppChange = await ctx.pgSql`
      SELECT id FROM sync_queue WHERE message_id = ${msgId} AND status = 'pending'
    `;
    expect(queueAfterAppChange.length).toBeGreaterThanOrEqual(1);

    // Run outbound (STORE \\Seen on IMAP, bumps sync_version)
    const outbound = new OutboundProcessor(
      ctx.db,
      getDatabaseUrl(ctx.schema),
      () => ctx.imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );

    await outbound.drain(ctx.accountId);

    const afterOutbound = await ctx.pgSql`
      SELECT sync_version, is_seen FROM messages WHERE id = ${msgId}
    `;
    expect(Number(afterOutbound[0].sync_version)).toBeGreaterThan(syncVersionAfterInbound);
    expect(afterOutbound[0].is_seen).toBe(true);

    const queueCountBefore = await ctx.pgSql`
      SELECT COUNT(*) as cnt FROM sync_queue WHERE message_id = ${msgId}
    `;

    // Run inbound sync (detects \\Seen on IMAP)
    const inbound2 = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const syncResult = await inbound2.syncFolder(ctx.folderId, "INBOX");
    expect(syncResult.errors).toEqual([]);

    // Verify: NO new sync_queue entries were created
    const queueCountAfter = await ctx.pgSql`
      SELECT COUNT(*) as cnt FROM sync_queue WHERE message_id = ${msgId}
    `;
    expect(Number(queueCountAfter[0].cnt)).toBe(Number(queueCountBefore[0].cnt));

    const finalState = await ctx.pgSql`
      SELECT is_seen, sync_version FROM messages WHERE id = ${msgId}
    `;
    expect(finalState[0].is_seen).toBe(true);
  });
});
