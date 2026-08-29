import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  appendBulkMessages,
  connectImap,
  deliverAndWait,
  type E2EContext,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-inbound" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: inbound sync", () => {
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
        imapClient: rawClient,
      });
    } finally {
      await rawClient.logout();
    }

    // Reconnect the IMAP client to get a fresh mailbox view
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
      WHERE folder_id = ${ctx.folderId} AND expunged_at IS NULL
    `;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const msg = rows.find((r) => r.subject === uniqueSubject);
    expect(msg).toBeDefined();
    expect(msg?.body_text).toContain(bodyText);
    expect(msg?.from_addr).toContain(ctx.testEmail);
  });

  test("external IMAP flag change is reflected in PG after sync", async () => {
    const uniqueSubject = `Flag Test ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await deliverAndWait({
        from: ctx.testEmail,
        to: ctx.testEmail,
        subject: uniqueSubject,
        text: "Test body for flag change test.",
        imapClient: checkClient,
      });
    } finally {
      await checkClient.logout();
    }

    const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);

    const result1 = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(result1.errors).toEqual([]);
    expect(result1.newMessages).toBeGreaterThanOrEqual(1);

    const beforeRows = await ctx.pgSql`
      SELECT imap_uid, is_seen, updated_at FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND expunged_at IS NULL
    `;
    expect(beforeRows).toHaveLength(1);
    const beforeUpdatedAt = new Date(beforeRows[0].updated_at).getTime();

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
      SELECT is_seen, updated_at FROM messages
      WHERE folder_id = ${ctx.folderId} AND subject = ${uniqueSubject} AND expunged_at IS NULL
    `;
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].is_seen).toBe(true);
    expect(new Date(afterRows[0].updated_at).getTime()).toBeGreaterThan(beforeUpdatedAt);
  });

  test("120+ bulk messages sync into PG with no NULL body_text", async () => {
    const BULK_COUNT = 120;
    const appendClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await appendBulkMessages(appendClient, "INBOX", BULK_COUNT, ["\\Seen"]);
    await appendClient.logout();

    const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);

    const result = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBeGreaterThanOrEqual(BULK_COUNT);

    const rows = await ctx.pgSql`
      SELECT id, subject, body_text, is_seen FROM messages
      WHERE folder_id = ${ctx.folderId} AND expunged_at IS NULL AND subject LIKE 'Bulk message%'
    `;

    expect(rows.length).toBeGreaterThanOrEqual(BULK_COUNT);

    const nullBodies = rows.filter((r) => r.body_text === null);
    expect(nullBodies).toHaveLength(0);

    const unseenCount = rows.filter((r) => !r.is_seen).length;
    expect(unseenCount).toBe(0);
  });
});
