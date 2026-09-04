import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  appendBulkMessages,
  connectImap,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-bulk" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

function makeProcessor(batchSize?: number): OutboundProcessor {
  return new OutboundProcessor(
    ctx.db,
    getDatabaseUrl(ctx.schema),
    () => ctx.imapClient,
    async () => testCapabilities,
    60_000,
    5,
    batchSize,
  );
}

async function createIsolatedFolder(name: string): Promise<{ folderId: string; imapName: string }> {
  const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    await setupClient.mailboxCreate(name);
  } finally {
    await setupClient.logout();
  }
  const folderId = randomUUID();
  await ctx.pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name)
    VALUES (${folderId}, ${ctx.accountId}, ${name}, ${name})
  `;
  return { folderId, imapName: name };
}

/**
 * Every count of a method the outbound processor calls on the shared ImapFlow instance,
 * for the lifetime of the returned object. Patches the instance, not the prototype, so it
 * never leaks into another test running against the same connection.
 */
function spyOnImapCalls(): { counts: Record<string, number>; restore: () => void } {
  const client = ctx.imapClient.client;
  const methods = [
    "messageFlagsAdd",
    "messageFlagsRemove",
    "messageMove",
    "messageDelete",
  ] as const;
  const counts: Record<string, number> = {};
  const originals: Partial<Record<(typeof methods)[number], unknown>> = {};

  for (const method of methods) {
    counts[method] = 0;
    // biome-ignore lint/suspicious/noExplicitAny: patching an instance method for a call count
    originals[method] = (client as any)[method];
    // biome-ignore lint/suspicious/noExplicitAny: same instrumentation
    (client as any)[method] = (...args: unknown[]) => {
      counts[method]++;
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the original bound method
      return (originals[method] as any).apply(client, args);
    };
  }

  return {
    counts,
    restore: () => {
      for (const method of methods) {
        // biome-ignore lint/suspicious/noExplicitAny: undoing the instance-level patch
        delete (client as any)[method];
      }
    },
  };
}

async function unseenCount(imapName: string): Promise<number> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    const status = await client.status(imapName, { unseen: true });
    return status.unseen ?? 0;
  } finally {
    await client.logout();
  }
}

async function messageCount(imapName: string): Promise<number> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    const status = await client.status(imapName, { messages: true });
    return status.messages ?? 0;
  } finally {
    await client.logout();
  }
}

describe("E2E: outbound queue at scale", () => {
  const MESSAGE_COUNT = 300;

  test("a bulk flag change over many messages lands in one STORE, not one per message", async () => {
    const { folderId, imapName } = await createIsolatedFolder(
      `BulkFlag-${randomUUID().slice(0, 8)}`,
    );

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await appendBulkMessages(directClient, imapName, MESSAGE_COUNT, []);
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const synced = await inbound.fullSync(folderId, imapName);
    expect(synced.newMessages).toBe(MESSAGE_COUNT);

    // One statement, one transaction: the trigger enqueues MESSAGE_COUNT independent
    // flag_add rows, exactly what a UI's "mark all as read" produces.
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE folder_id = ${folderId}`;

    // sync_queue.folder_id is NULL on a flag_add row -- the trigger never sets it, the
    // outbound claim query resolves it from the message join instead -- so counting
    // "this folder's" entries has to go through messages, not the raw column.
    const queued = await ctx.pgSql`
      SELECT COUNT(*) AS cnt FROM sync_queue sq
      JOIN messages m ON sq.message_id = m.id
      WHERE m.folder_id = ${folderId} AND sq.action = 'flag_add'
    `;
    expect(Number(queued[0].cnt)).toBe(MESSAGE_COUNT);

    const spy = spyOnImapCalls();
    const startedAt = Date.now();
    let processed: number;
    try {
      processed = await makeProcessor().drain(ctx.accountId);
    } finally {
      spy.restore();
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(`[bulk-batching] ${MESSAGE_COUNT} flag_add entries drained in ${elapsedMs}ms`);

    // >= rather than ==: creating the isolated folder above enqueues its own incidental
    // folder_create entry (an app-level row for a mailbox that already exists), and
    // drain() clears the whole account's queue, not just this test's own entries.
    expect(processed).toBeGreaterThanOrEqual(MESSAGE_COUNT);
    // The whole folder shares one flag and one source folder, so it's one STORE covering
    // every UID -- not MESSAGE_COUNT of them.
    expect(spy.counts.messageFlagsAdd).toBe(1);
    // A ten-per-batch, one-batch-per-wakeup drain would need 30 poll ticks at the default
    // five-second interval (~150s) to get through this many; this bounds the regression
    // generously rather than pinning an exact number that would be sensitive to host load.
    expect(elapsedMs).toBeLessThan(15_000);

    expect(await unseenCount(imapName)).toBe(0);

    const completed = await ctx.pgSql`
      SELECT COUNT(*) AS cnt FROM sync_queue sq
      JOIN messages m ON sq.message_id = m.id
      WHERE m.folder_id = ${folderId} AND sq.action = 'flag_add' AND sq.status = 'completed'
    `;
    expect(Number(completed[0].cnt)).toBe(MESSAGE_COUNT);
  }, 90_000);

  test("a bulk move over many messages lands in one MOVE, not one per message", async () => {
    const { folderId: sourceId, imapName: sourceName } = await createIsolatedFolder(
      `BulkMoveSrc-${randomUUID().slice(0, 8)}`,
    );
    const { folderId: targetId, imapName: targetName } = await createIsolatedFolder(
      `BulkMoveDst-${randomUUID().slice(0, 8)}`,
    );

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await appendBulkMessages(directClient, sourceName, MESSAGE_COUNT, []);
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const synced = await inbound.fullSync(sourceId, sourceName);
    expect(synced.newMessages).toBe(MESSAGE_COUNT);

    await ctx.pgSql`UPDATE messages SET folder_id = ${targetId} WHERE folder_id = ${sourceId}`;

    const spy = spyOnImapCalls();
    const startedAt = Date.now();
    let processed: number;
    try {
      processed = await makeProcessor().drain(ctx.accountId);
    } finally {
      spy.restore();
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(`[bulk-batching] ${MESSAGE_COUNT} move entries drained in ${elapsedMs}ms`);

    // >= rather than ==: the two isolated folders created above each enqueue their own
    // incidental folder_create entry, and drain() clears the whole account's queue.
    expect(processed).toBeGreaterThanOrEqual(MESSAGE_COUNT);
    expect(spy.counts.messageMove).toBe(1);
    expect(elapsedMs).toBeLessThan(15_000);

    expect(await messageCount(sourceName)).toBe(0);
    expect(await messageCount(targetName)).toBe(MESSAGE_COUNT);
  }, 90_000);

  test("archive-and-mark-read over many messages: the flag still lands after the move, in two round trips", async () => {
    const { folderId: sourceId, imapName: sourceName } = await createIsolatedFolder(
      `BulkBothSrc-${randomUUID().slice(0, 8)}`,
    );
    const { folderId: targetId, imapName: targetName } = await createIsolatedFolder(
      `BulkBothDst-${randomUUID().slice(0, 8)}`,
    );

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await appendBulkMessages(directClient, sourceName, MESSAGE_COUNT, []);
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const synced = await inbound.fullSync(sourceId, sourceName);
    expect(synced.newMessages).toBe(MESSAGE_COUNT);

    // Two separate statements -- move, then mark read -- the same shape a UI's "archive"
    // action produces when it flags a message read on the way out. The move nulls
    // imap_uid, so the flag_add row this second statement enqueues has nothing to resolve
    // against until the move actually runs on the server.
    await ctx.pgSql`UPDATE messages SET folder_id = ${targetId} WHERE folder_id = ${sourceId}`;
    await ctx.pgSql`UPDATE messages SET is_seen = true WHERE folder_id = ${targetId}`;

    // A move and a flag change per message is 2 * MESSAGE_COUNT rows -- above the default
    // claim size of 500, which would otherwise split the flag STORE across two claims for
    // no reason relevant to what this test is proving. A large mailbox's real bulk action
    // spans several claims regardless; that's covered by the single-action tests above,
    // which stay under the default on their own.
    const spy = spyOnImapCalls();
    const startedAt = Date.now();
    let processed: number;
    try {
      processed = await makeProcessor(2 * MESSAGE_COUNT + 10).drain(ctx.accountId);
    } finally {
      spy.restore();
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[bulk-batching] ${MESSAGE_COUNT} moved+flagged messages drained in ${elapsedMs}ms`,
    );

    // >= rather than ==: the two isolated folders created above each enqueue their own
    // incidental folder_create entry, and drain() clears the whole account's queue.
    expect(processed).toBeGreaterThanOrEqual(2 * MESSAGE_COUNT);
    expect(spy.counts.messageMove).toBe(1);
    expect(spy.counts.messageFlagsAdd).toBe(1);
    expect(elapsedMs).toBeLessThan(15_000);

    expect(await messageCount(targetName)).toBe(MESSAGE_COUNT);
    expect(await unseenCount(targetName)).toBe(0);

    // sync_queue.folder_id is never set by the flag/move triggers -- it's resolved from
    // the message join only at claim time -- so this checks account-wide rather than
    // filtering on a column that's NULL on every row anyway. Every other test in this
    // file completes cleanly, so a nonzero count here can only be this test's own.
    const dead = await ctx.pgSql`
      SELECT COUNT(*) AS cnt FROM sync_queue WHERE account_id = ${ctx.accountId} AND status = 'dead'
    `;
    expect(Number(dead[0].cnt)).toBe(0);
  }, 90_000);
});
