import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  clearMailpitMessages,
  connectImap,
  deliverTestEmail,
  type E2EContext,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
  waitFor,
} from "../../setup/e2e-helpers.js";
import { insertMirroredFolder } from "../../setup/pg-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-queued-writes" });
});

afterEach(async () => {
  await clearMailpitMessages();
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

function inbound(caps = testCapabilities): InboundSync {
  return new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, caps);
}

/**
 * ctx.imapClient is shared across this file, and getMailboxLock() is a no-op when the
 * mailbox is already selected -- so it never re-syncs with mail delivered externally
 * through a different connection. NOOP forces that refresh before a sync runs.
 */
async function refresh(): Promise<void> {
  if (ctx.imapClient.isConnected()) await ctx.imapClient.client.noop();
}

async function deliverToInbox(subject: string): Promise<void> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    const before = (await client.status("INBOX", { messages: true })).messages ?? 0;
    await deliverTestEmail({ from: ctx.testEmail, to: ctx.testEmail, subject, text: subject });
    await waitFor(
      async () => ((await client.status("INBOX", { messages: true })).messages ?? 0) > before,
      { timeout: 10_000, interval: 300 },
    );
  } finally {
    await client.logout();
  }
}

describe("E2E: inbound sync does not undo a queued outbound write", () => {
  test("account-start fullSync does not un-expunge a message whose delete is still queued", async () => {
    const subject = `Resurrect fullSync ${randomUUID().slice(0, 8)}`;
    await deliverToInbox(subject);
    await refresh();
    await inbound().fullSync(ctx.folderId, "INBOX", true);
    const [msg] = await ctx.pgSql`SELECT id FROM messages WHERE subject = ${subject}`;

    // The contract's delete, as a consumer would issue it.
    await ctx.pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${msg.id}`;
    const queued = await ctx.pgSql`
      SELECT status FROM sync_queue WHERE message_id = ${msg.id} AND action = 'delete'
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("pending");

    // What AccountSync.start() runs for every folder, before the outbound processor has
    // had a chance to actually expunge it on the server -- the message is still there.
    await refresh();
    await inbound().fullSync(ctx.folderId, "INBOX", true);

    const [after] = await ctx.pgSql`SELECT expunged_at FROM messages WHERE id = ${msg.id}`;
    expect(after.expunged_at).not.toBeNull();
    const stillQueued = await ctx.pgSql`
      SELECT status FROM sync_queue WHERE message_id = ${msg.id} AND action = 'delete'
    `;
    expect(stillQueued[0].status).toBe("pending");

    // Not duplicated either: the diff must not have re-inserted it as a new UID.
    const rows = await ctx.pgSql`SELECT id FROM messages WHERE subject = ${subject}`;
    expect(rows).toHaveLength(1);
  });

  test("condstore-tier syncFolder does the same on an ordinary cycle", async () => {
    const subject = `Resurrect condstore ${randomUUID().slice(0, 8)}`;
    await deliverToInbox(subject);
    await refresh();
    await inbound().fullSync(ctx.folderId, "INBOX", true);
    const [msg] = await ctx.pgSql`SELECT id FROM messages WHERE subject = ${subject}`;
    await ctx.pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${msg.id}`;

    await refresh();
    const condstoreOnly = { ...testCapabilities, qresync: false };
    await inbound(condstoreOnly).syncFolder(ctx.folderId, "INBOX");

    const [after] = await ctx.pgSql`SELECT expunged_at FROM messages WHERE id = ${msg.id}`;
    expect(after.expunged_at).not.toBeNull();
  });

  test("a pending optimistic move out of a folder is not duplicated by that folder's own fullSync", async () => {
    const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await setupClient.mailboxCreate("Archive").catch(() => {});
    } finally {
      await setupClient.logout();
    }
    const archiveId = randomUUID();
    await insertMirroredFolder(
      ctx.pgSql,
      (tx) => tx`
        INSERT INTO folders (id, account_id, imap_name, display_name, special_use, initial_sync_done)
        VALUES (${archiveId}, ${ctx.accountId}, 'Archive', 'Archive', 'archive', true)
      `,
    );

    const subject = `No dup move ${randomUUID().slice(0, 8)}`;
    await deliverToInbox(subject);
    await refresh();
    await inbound().fullSync(ctx.folderId, "INBOX", true);
    const [msg] = await ctx.pgSql`SELECT id FROM messages WHERE subject = ${subject}`;

    // The optimistic move: PG moves the row before PostIMAP has told the server anything.
    await ctx.pgSql`
      UPDATE messages SET folder_id = ${archiveId}, imap_uid = NULL WHERE id = ${msg.id}
    `;
    const queued = await ctx.pgSql`
      SELECT status FROM sync_queue WHERE message_id = ${msg.id} AND action = 'move'
    `;
    expect(queued).toHaveLength(1);

    // A fullSync of the SOURCE folder -- the message is still there on the server, since
    // the move hasn't executed yet, and PG no longer has a row under this folder_id at
    // that UID at all.
    await refresh();
    await inbound().fullSync(ctx.folderId, "INBOX", true);

    const rows = await ctx.pgSql<{ id: string; folder_id: string; imap_uid: string | null }[]>`
      SELECT id, folder_id, imap_uid FROM messages WHERE subject = ${subject}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].folder_id).toBe(archiveId);
    expect(rows[0].imap_uid).toBeNull();
  });
});
