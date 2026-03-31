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
  ctx = await setupE2EContext({ emailPrefix: "e2e-conflict" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: bidirectional conflict -- IMAP state wins (authoritative)", () => {
  test("app and IMAP both change is_seen simultaneously, IMAP wins after sync", async () => {
    const uniqueSubject = `Conflict Test ${randomUUID().slice(0, 8)}`;

    // 1. Deliver email and wait for arrival
    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Body for conflict test.",
        auth: { user: ctx.testEmail, pass: ctx.testPassword },
        imapClient: checkClient,
      });
    } finally {
      await checkClient.logout();
    }

    // 2. Run initial inbound sync
    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const initialSync = await inbound.syncFolder(ctx.folderId, "INBOX");
    expect(initialSync.errors).toEqual([]);

    // Get message from PG
    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const msgRows = await ctx.pgSql`
      SELECT id, imap_uid FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND deleted_at IS NULL
    `;
    expect(msgRows).toHaveLength(1);
    const msgId = msgRows[0].id;
    const imapUid = Number(msgRows[0].imap_uid);

    // 3. Conflict scenario: App sets is_seen=true in PG
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;

    // 4. Run outbound to push \\Seen to IMAP
    const outbound = new OutboundProcessor(
      ctx.db,
      getDatabaseUrl(ctx.schema),
      () => ctx.imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );
    await outbound.drain(ctx.accountId);

    // Simulate external client removing \\Seen (the "conflict" -- external overrides)
    const extClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const extLock = await extClient.getMailboxLock("INBOX");
      try {
        await extClient.messageFlagsRemove(String(imapUid), ["\\Seen"], { uid: true });
      } finally {
        extLock.release();
      }
    } finally {
      await extClient.logout();
    }

    // 5. Run inbound sync to pick up the external change
    const inbound2 = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    await inbound2.syncFolder(ctx.folderId, "INBOX");

    // 6. Verify: IMAP state wins. PG should now have is_seen=false
    const finalPg = await ctx.pgSql`
      SELECT is_seen FROM messages WHERE id = ${msgId}
    `;
    expect(finalPg[0].is_seen).toBe(false);

    // Verify IMAP also shows not seen
    const verifyClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const verifyLock = await verifyClient.getMailboxLock("INBOX");
      try {
        const msg = await verifyClient.fetchOne(String(imapUid), { uid: true, flags: true });
        expect(msg.flags.has("\\Seen")).toBe(false);
      } finally {
        verifyLock.release();
      }
    } finally {
      await verifyClient.logout();
    }
  });
});
