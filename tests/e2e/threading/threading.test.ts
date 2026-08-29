import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  deliverAndWait,
  type E2EContext,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-threading" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

async function threadIdOf(subject: string): Promise<string> {
  const rows = await ctx.pgSql`SELECT thread_id FROM messages WHERE subject = ${subject}`;
  expect(rows).toHaveLength(1);
  return rows[0].thread_id;
}

/**
 * ctx.imapClient is reused across tests in this file. getMailboxLock() is a no-op once
 * the mailbox is already selected, so it never re-syncs with mail delivered externally
 * over LMTP by a different connection. NOOP forces that refresh before syncFolder acts
 * on ctx.imapClient's view of the mailbox (same reasoning as outbound-sync.test.ts).
 */
async function refreshSharedClient(): Promise<void> {
  if (ctx.imapClient.isConnected()) {
    await ctx.imapClient.client.noop();
  }
}

async function syncInbox() {
  const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
  const result = await inbound.syncFolder(ctx.folderId, "INBOX");
  expect(result.errors).toEqual([]);
  return result;
}

describe("E2E: threading via References/In-Reply-To", () => {
  test("a reply chain synced from IMAP shares one thread_id", async () => {
    const suffix = randomUUID().slice(0, 8);
    const rootSubject = `Thread root ${suffix}`;
    const replySubject = `Re: Thread root ${suffix}`;
    const grandchildSubject = `Re: Re: Thread root ${suffix}`;

    const rootMessageId = `<root-${suffix}@test.local>`;
    const replyMessageId = `<reply-${suffix}@test.local>`;

    await deliverAndWait({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject: rootSubject,
      text: "Original message.",
      messageId: rootMessageId,
      imapClient: ctx.imapClient.client,
    });

    await deliverAndWait({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject: replySubject,
      text: "First reply.",
      messageId: replyMessageId,
      inReplyTo: rootMessageId,
      references: [rootMessageId],
      imapClient: ctx.imapClient.client,
    });

    await deliverAndWait({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject: grandchildSubject,
      text: "Reply to the reply.",
      inReplyTo: replyMessageId,
      references: [rootMessageId, replyMessageId],
      imapClient: ctx.imapClient.client,
    });

    await refreshSharedClient();
    await syncInbox();

    const rootThread = await threadIdOf(rootSubject);
    const replyThread = await threadIdOf(replySubject);
    const grandchildThread = await threadIdOf(grandchildSubject);

    expect(replyThread).toBe(rootThread);
    expect(grandchildThread).toBe(rootThread);
  });

  test("an unrelated message gets its own thread_id", async () => {
    const suffix = randomUUID().slice(0, 8);
    const subject = `Unrelated ${suffix}`;

    await deliverAndWait({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject,
      text: "Nothing to do with the other thread.",
      imapClient: ctx.imapClient.client,
    });

    await refreshSharedClient();
    await syncInbox();

    const threadId = await threadIdOf(subject);
    const allThreads = await ctx.pgSql`
      SELECT DISTINCT thread_id FROM messages WHERE account_id = ${ctx.accountId}
    `;
    expect(allThreads.length).toBeGreaterThan(1);
    expect(allThreads.map((r: { thread_id: string }) => r.thread_id)).toContain(threadId);
  });
});
