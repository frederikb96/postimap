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
  ctx = await setupE2EContext({ emailPrefix: "e2e-outcoal" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: outbound coalescing (rapid toggles)", () => {
  test("rapid 5x is_seen toggle in PG results in coalesced operations", async () => {
    const uniqueSubject = `OutCoal ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    let imapUid: number;
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Body for outbound coalescing test.",
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

    // Rapid 5x toggle: false->true->false->true->false->true
    for (let i = 0; i < 5; i++) {
      const newVal = i % 2 === 0;
      await ctx.pgSql`UPDATE messages SET is_seen = ${newVal} WHERE id = ${msgId}`;
    }

    const queueBefore = await ctx.pgSql`
      SELECT id, action, payload FROM sync_queue
      WHERE message_id = ${msgId} AND status = 'pending'
      ORDER BY created_at
    `;
    expect(queueBefore.length).toBeGreaterThanOrEqual(3);

    const processor = new OutboundProcessor(
      ctx.db,
      getDatabaseUrl(ctx.schema),
      () => ctx.imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );

    await processor.drain(ctx.accountId);

    const coalescedAudits = await ctx.pgSql`
      SELECT detail FROM sync_audit
      WHERE message_id = ${msgId} AND detail::text LIKE '%coalesced%'
    `;

    expect(coalescedAudits.length).toBeGreaterThanOrEqual(1);

    const totalCompleted = await ctx.pgSql`
      SELECT COUNT(*) as cnt FROM sync_queue
      WHERE message_id = ${msgId} AND status = 'completed'
    `;
    expect(Number(totalCompleted[0].cnt)).toBe(queueBefore.length);
  });
});
