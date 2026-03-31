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
  ctx = await setupE2EContext({ emailPrefix: "e2e-outdel" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: outbound delete sync (PG -> IMAP)", () => {
  test("soft-deleting in PG removes message from IMAP", async () => {
    const uniqueSubject = `OutDel ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    let imapUid: number;
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Body for outbound delete test.",
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
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, sync_version)
      VALUES (${msgId}, ${ctx.accountId}, ${ctx.folderId}, ${String(imapUid)},
        ${uniqueSubject}, '1')
    `;

    // App-level soft delete
    await ctx.pgSql`UPDATE messages SET deleted_at = now() WHERE id = ${msgId}`;

    const queueRows = await ctx.pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${msgId}
    `;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].action).toBe("delete");

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
        const uids = await verifyClient.search({ all: true }, { uid: true });
        if (uids !== false) {
          expect(uids).not.toContain(imapUid);
        }
      } finally {
        verifyLock.release();
      }
    } finally {
      await verifyClient.logout();
    }
  });
});
