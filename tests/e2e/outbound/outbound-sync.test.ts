import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  connectImap,
  deliverTestEmail,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
  waitFor,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-outbound" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

/**
 * Delivers a message and returns its UID. All tests in this file share one INBOX, so
 * this waits for the message COUNT to increase past its pre-delivery baseline (not just
 * > 0) and returns the highest UID, rather than trusting an earlier test's message isn't
 * still the first result.
 */
async function deliverAndGetUid(subject: string, body: string): Promise<number> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    // STATUS gives a live count without needing the mailbox selected, so a repeated
    // poll actually re-queries the server -- an already-selected mailbox otherwise
    // only updates its cached exists count on unsolicited server pushes, which a
    // non-IDLE connection sitting between commands won't necessarily receive in time.
    const baselineStatus = await client.status("INBOX", { messages: true });
    const baseline = baselineStatus.messages ?? 0;

    await deliverTestEmail({ from: ctx.testEmail, to: ctx.testEmail, subject, text: body });
    await waitFor(
      async () => {
        const status = await client.status("INBOX", { messages: true });
        return (status.messages ?? 0) > baseline;
      },
      { timeout: 10_000, interval: 300 },
    );

    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ all: true }, { uid: true });
      expect(uids).not.toBe(false);
      return Math.max(...(uids as number[]));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/**
 * ctx.imapClient is reused across all tests in this file. getMailboxLock() is a no-op
 * when the mailbox is already selected (see ImapFlow's own docs), so it never re-syncs
 * with messages delivered externally through a different connection. NOOP forces that
 * refresh before the outbound processor acts on ctx.imapClient's view of the mailbox.
 */
async function refreshSharedClient(): Promise<void> {
  if (ctx.imapClient.isConnected()) {
    await ctx.imapClient.client.noop();
  }
}

function makeProcessor(): OutboundProcessor {
  return new OutboundProcessor(
    ctx.db,
    getDatabaseUrl(ctx.schema),
    () => ctx.imapClient,
    async () => testCapabilities,
    60_000,
    5,
  );
}

describe("E2E: outbound sync (PG -> IMAP)", () => {
  test("setting is_seen=true in PG results in \\Seen flag on IMAP", async () => {
    const uniqueSubject = `OutFlag ${randomUUID().slice(0, 8)}`;
    const imapUid = await deliverAndGetUid(uniqueSubject, "Body for outbound flag test.");

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

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

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

  test("soft-deleting in PG removes message from IMAP", async () => {
    const uniqueSubject = `OutDel ${randomUUID().slice(0, 8)}`;
    const imapUid = await deliverAndGetUid(uniqueSubject, "Body for outbound delete test.");

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

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

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

  test("updating folder_id in PG moves message on IMAP", async () => {
    const uniqueSubject = `OutMove ${randomUUID().slice(0, 8)}`;
    const imapUid = await deliverAndGetUid(uniqueSubject, "Body for outbound move test.");

    const trashFolderId = randomUUID();
    const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      await setupClient.mailboxCreate("Trash");
    } finally {
      await setupClient.logout();
    }
    await ctx.pgSql`
      INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
      VALUES (${trashFolderId}, ${ctx.accountId}, 'Trash', 'Trash', 'trash')
    `;

    const msgId = randomUUID();
    await ctx.pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, sync_version)
      VALUES (${msgId}, ${ctx.accountId}, ${ctx.folderId}, ${String(imapUid)},
        ${uniqueSubject}, '1')
    `;

    // App-level move: change folder_id from INBOX to Trash
    await ctx.pgSql`UPDATE messages SET folder_id = ${trashFolderId} WHERE id = ${msgId}`;

    const queueRows = await ctx.pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${msgId}
    `;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].action).toBe("move");

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    const verifyClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const inboxLock = await verifyClient.getMailboxLock("INBOX");
      try {
        const inboxUids = await verifyClient.search({ all: true }, { uid: true });
        if (inboxUids !== false) {
          expect(inboxUids).not.toContain(imapUid);
        }
      } finally {
        inboxLock.release();
      }

      const trashLock = await verifyClient.getMailboxLock("Trash");
      try {
        const trashUids = await verifyClient.search({ all: true }, { uid: true });
        expect(trashUids).not.toBe(false);
        expect((trashUids as number[]).length).toBeGreaterThanOrEqual(1);
      } finally {
        trashLock.release();
      }
    } finally {
      await verifyClient.logout();
    }
  });

  test("rapid 5x is_seen toggle in PG results in coalesced operations", async () => {
    const uniqueSubject = `OutCoal ${randomUUID().slice(0, 8)}`;
    const imapUid = await deliverAndGetUid(uniqueSubject, "Body for outbound coalescing test.");

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

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

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
