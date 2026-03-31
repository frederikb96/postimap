import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  ctx = await setupE2EContext({ emailPrefix: "e2e-outflag" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: outbound flag sync (PG -> IMAP)", () => {
  test("setting is_seen=true in PG results in \\Seen flag on IMAP after outbound processing", async () => {
    const uniqueSubject = `OutFlag ${randomUUID().slice(0, 8)}`;

    let imapUid: number;
    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Body for outbound flag test.",
        auth: { user: ctx.testEmail, pass: ctx.testPassword },
        imapClient: checkClient,
      });

      const inboxLock = await checkClient.getMailboxLock("INBOX");
      try {
        const uids = await checkClient.search({ all: true }, { uid: true });
        expect(uids).not.toBe(false);
        imapUid = (uids as number[])[0];
      } finally {
        inboxLock.release();
      }
    } finally {
      await checkClient.logout();
    }

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const msgId = randomUUID();
    await ctx.pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, is_seen, sync_version)
      VALUES (${msgId}, ${ctx.accountId}, ${ctx.folderId}, ${String(imapUid)},
        ${uniqueSubject}, false, '1')
    `;

    // App sets is_seen=true (trigger fires -> sync_queue entry with flag_add \\Seen)
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;

    const queueRows = await ctx.pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${msgId} AND status = 'pending'
    `;
    expect(queueRows.length).toBeGreaterThanOrEqual(1);
    const flagEntry = queueRows.find((r) => r.action === "flag_add");
    expect(flagEntry).toBeDefined();

    const processor = new OutboundProcessor(
      ctx.db,
      getDatabaseUrl(ctx.schema),
      () => ctx.imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );

    await processor.drain(ctx.accountId);

    const verifyClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const verifyLock = await verifyClient.getMailboxLock("INBOX");
      try {
        const msg = await verifyClient.fetchOne(String(imapUid), { uid: true, flags: true });
        expect(msg).toBeTruthy();
        expect(msg.flags.has("\\Seen")).toBe(true);
      } finally {
        verifyLock.release();
      }
    } finally {
      await verifyClient.logout();
    }
  });
});
