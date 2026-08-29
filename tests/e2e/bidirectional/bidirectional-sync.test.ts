import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  connectImap,
  deliverAndWait,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-bidir" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

function makeInbound(): InboundSync {
  return new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
}

function makeOutbound(): OutboundProcessor {
  return new OutboundProcessor(
    ctx.db,
    getDatabaseUrl(ctx.schema),
    () => ctx.imapClient,
    async () => testCapabilities,
    60_000,
    5,
  );
}

/** Delivers a message, runs an initial inbound sync, and returns its PG id + IMAP UID. */
async function deliverAndSync(
  subject: string,
  body: string,
): Promise<{ msgId: string; imapUid: number }> {
  const checkClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    await deliverAndWait({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject,
      text: body,
      imapClient: checkClient,
    });
  } finally {
    await checkClient.logout();
  }

  const initialSync = await makeInbound().syncFolder(ctx.folderId, "INBOX");
  expect(initialSync.errors).toEqual([]);
  expect(initialSync.newMessages).toBeGreaterThanOrEqual(1);

  const msgRows = await ctx.pgSql`
    SELECT id, imap_uid FROM messages
    WHERE folder_id = ${ctx.folderId} AND subject = ${subject} AND expunged_at IS NULL
  `;
  expect(msgRows).toHaveLength(1);
  return { msgId: msgRows[0].id, imapUid: Number(msgRows[0].imap_uid) };
}

describe("E2E: bidirectional sync", () => {
  test("app and IMAP both change is_seen simultaneously, IMAP wins after sync", async () => {
    const { msgId, imapUid } = await deliverAndSync(
      `Conflict Test ${randomUUID().slice(0, 8)}`,
      "Body for conflict test.",
    );

    // Conflict scenario: App sets is_seen=true in PG, pushed to IMAP
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;
    await makeOutbound().drain(ctx.accountId);

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

    // Run inbound sync to pick up the external change. IMAP state wins.
    await makeInbound().syncFolder(ctx.folderId, "INBOX");

    const finalPg = await ctx.pgSql`SELECT is_seen FROM messages WHERE id = ${msgId}`;
    expect(finalPg[0].is_seen).toBe(false);

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

  test("both sides change different flags -> both flags present after sync cycles", async () => {
    const { msgId, imapUid } = await deliverAndSync(
      `Conv Test ${randomUUID().slice(0, 8)}`,
      "Body for convergence test.",
    );

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

    await makeOutbound().drain(ctx.accountId);
    await makeInbound().syncFolder(ctx.folderId, "INBOX");

    const pgState = await ctx.pgSql`SELECT is_seen, is_flagged FROM messages WHERE id = ${msgId}`;
    expect(pgState[0].is_seen).toBe(true);
    expect(pgState[0].is_flagged).toBe(true);

    await makeOutbound().drain(ctx.accountId);

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

  test("PG -> IMAP -> PG loop: flag set in PG, synced to IMAP, inbound does NOT re-enqueue", async () => {
    const { msgId } = await deliverAndSync(
      `Loop Test ${randomUUID().slice(0, 8)}`,
      "Body for loop prevention test.",
    );

    // App sets is_seen=true in PG (trigger fires -> sync_queue entry)
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${msgId}`;

    const queueAfterAppChange = await ctx.pgSql`
      SELECT id FROM sync_queue WHERE message_id = ${msgId} AND status = 'pending'
    `;
    expect(queueAfterAppChange.length).toBeGreaterThanOrEqual(1);

    // Run outbound (STORE \\Seen on IMAP -- a successful flag sync doesn't write PG at
    // all, so there's nothing here to guard against re-enqueueing yet).
    await makeOutbound().drain(ctx.accountId);

    const afterOutbound = await ctx.pgSql`SELECT is_seen FROM messages WHERE id = ${msgId}`;
    expect(afterOutbound[0].is_seen).toBe(true);

    const queueCountBefore = await ctx.pgSql`
      SELECT COUNT(*) as cnt FROM sync_queue WHERE message_id = ${msgId}
    `;

    // Run inbound sync (detects \\Seen on IMAP and writes it back to PG; updateFlags runs
    // inside a sync-writer transaction, so the outbound-enqueue trigger skips it -- no
    // re-enqueue, no bounce).
    const syncResult = await makeInbound().syncFolder(ctx.folderId, "INBOX");
    expect(syncResult.errors).toEqual([]);

    const queueCountAfter = await ctx.pgSql`
      SELECT COUNT(*) as cnt FROM sync_queue WHERE message_id = ${msgId}
    `;
    expect(Number(queueCountAfter[0].cnt)).toBe(Number(queueCountBefore[0].cnt));

    const finalState = await ctx.pgSql`SELECT is_seen FROM messages WHERE id = ${msgId}`;
    expect(finalState[0].is_seen).toBe(true);
  });
});
