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
  ctx = await setupE2EContext({ emailPrefix: "e2e-newmail" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: new mail inbound sync", () => {
  test("delivered email appears in PG after sync cycle", async () => {
    const uniqueSubject = `E2E New Mail ${randomUUID().slice(0, 8)}`;
    const bodyText = "This is the body for the E2E new-mail test.";

    const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);

    // Initial (full) sync -- should be empty
    const initialResult = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(initialResult.errors).toEqual([]);

    // Deliver email and wait for IMAP arrival
    const rawClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: bodyText,
        auth: { user: ctx.testEmail, pass: ctx.testPassword },
        imapClient: rawClient,
      });
    } finally {
      await rawClient.logout();
    }

    // Reconnect the IMAP client to get a fresh mailbox view
    // Ensure disconnect completes fully before reconnecting
    await ctx.imapClient.disconnect();
    await ctx.imapClient.connect();

    // Run sync cycle
    const syncResult = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(syncResult.errors).toEqual([]);
    expect(syncResult.newMessages).toBeGreaterThanOrEqual(1);

    // Verify message in PG
    const rows = await ctx.pgSql`
      SELECT subject, from_addr, body_text, is_seen, is_flagged
      FROM messages
      WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
    `;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const msg = rows.find((r) => r.subject === uniqueSubject);
    expect(msg).toBeDefined();
    expect(msg?.body_text).toContain(bodyText);
    expect(msg?.from_addr).toContain(ctx.testEmail);
  });
});
