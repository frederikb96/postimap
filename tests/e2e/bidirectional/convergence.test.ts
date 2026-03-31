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
  waitFor,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-conv" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: bidirectional convergence", () => {
  test("both sides change different flags -> both flags present after sync cycles", async () => {
    const uniqueSubject = `Conv Test ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Body for convergence test.",
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
      SELECT id, imap_uid FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND deleted_at IS NULL
    `;
    expect(msgRows).toHaveLength(1);
    const msgId = msgRows[0].id;
    const imapUid = Number(msgRows[0].imap_uid);

    await ctx.pgSql`UPDATE messages SET is_flagged = true WHERE id = ${msgId}`;

    const extClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const extLock = await extClient.getMailboxLock("INBOX");
      try {
        await extClient.messageFlagsAdd(String(imapUid), ["\\Seen"], { uid: true });
      } finally {
        extLock.release();
      }
    } finally {
      await extClient.logout();
    }

    const outbound = new OutboundProcessor(
      ctx.db,
      getDatabaseUrl(ctx.schema),
      () => ctx.imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );

    await outbound.drain(ctx.accountId);

    const inbound2 = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    await inbound2.syncFolder(ctx.folderId, "INBOX");

    const pgState = await ctx.pgSql`
      SELECT is_seen, is_flagged FROM messages WHERE id = ${msgId}
    `;
    expect(pgState[0].is_seen).toBe(true);
    expect(pgState[0].is_flagged).toBe(true);

    const outbound2 = new OutboundProcessor(
      ctx.db,
      getDatabaseUrl(ctx.schema),
      () => ctx.imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );

    await outbound2.drain(ctx.accountId);

    const verifyClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const verifyLock = await verifyClient.getMailboxLock("INBOX");
      try {
        const msg = await verifyClient.fetchOne(String(imapUid), { uid: true, flags: true });
        expect(msg).toBeTruthy();
        expect(msg.flags.has("\\Seen")).toBe(true);
        expect(msg.flags.has("\\Flagged")).toBe(true);
      } finally {
        verifyLock.release();
      }
    } finally {
      await verifyClient.logout();
    }
  });
});
