import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { moveMessage } from "../../../src/protocol/move-handler.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import { startupRecovery } from "../../../src/sync/startup.js";
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
let middleId: string;
let finalId: string;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-chained" });

  const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    await setupClient.mailboxCreate("Middle");
    await setupClient.mailboxCreate("Final");
  } finally {
    await setupClient.logout();
  }

  const rows = await ctx.pgSql<{ id: string; imap_name: string }[]>`
    INSERT INTO folders (account_id, imap_name) VALUES
      (${ctx.accountId}, 'Middle'), (${ctx.accountId}, 'Final')
    RETURNING id::text AS id, imap_name
  `;
  middleId = rows.find((r) => r.imap_name === "Middle")?.id as string;
  finalId = rows.find((r) => r.imap_name === "Final")?.id as string;
  // Those inserts are consumer-shaped and enqueue folder_create for mailboxes that
  // already exist; draining settles them so the assertions below see only their own work.
  await makeProcessor().drain(ctx.accountId);
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

/**
 * ctx.imapClient is shared across this file, and getMailboxLock() is a no-op when the
 * mailbox is already selected -- so it never re-syncs with mail delivered externally
 * through a different connection. NOOP forces that refresh before the processor acts on
 * this client's view.
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

/**
 * Deliver a message, let it reach PG, and hand back its row id and UID.
 *
 * The row carries the RFC Message-ID the server actually stored, the way a real inbound
 * sync would -- it is the only identity that survives a move, so recovery depends on it.
 */
async function seedMessage(subject: string): Promise<{ id: string; uid: number }> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  const headerId = `<chained-${randomUUID()}@test.local>`;
  let uid: number;
  try {
    const before = (await client.status("INBOX", { messages: true })).messages ?? 0;
    await deliverTestEmail({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject,
      text: "chained",
      messageId: headerId,
    });
    await waitFor(
      async () => ((await client.status("INBOX", { messages: true })).messages ?? 0) > before,
      { timeout: 10_000, interval: 300 },
    );
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ all: true }, { uid: true })) as number[];
      uid = Math.max(...uids);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  const id = randomUUID();
  await ctx.pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, message_id)
    VALUES (${id}, ${ctx.accountId}, ${ctx.folderId}, ${String(uid)}, ${subject}, ${headerId})
  `;
  await ctx.pgSql`DELETE FROM sync_queue WHERE account_id = ${ctx.accountId}`;
  return { id, uid };
}

async function uidsIn(mailbox: string): Promise<number[]> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const found = await client.search({ all: true }, { uid: true });
      return found === false ? [] : (found as number[]);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function subjectsIn(mailbox: string): Promise<string[]> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  const subjects: string[] = [];
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      for await (const msg of client.fetch({ all: true }, { envelope: true }, { uid: true })) {
        if (msg.envelope?.subject) subjects.push(msg.envelope.subject);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return subjects;
}

describe("E2E: several operations on one message before the queue drains", () => {
  test("moved twice, the message lands in the final folder", async () => {
    const subject = `Chain ${randomUUID().slice(0, 8)}`;
    const { id } = await seedMessage(subject);

    // Both writes land before the processor runs -- the everyday case is one app
    // transaction doing more than one thing to the same message.
    await ctx.pgSql`
      UPDATE messages SET folder_id = ${middleId}, imap_uid = NULL WHERE id = ${id}
    `;
    await ctx.pgSql`
      UPDATE messages SET folder_id = ${finalId}, imap_uid = NULL WHERE id = ${id}
    `;

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    expect(await subjectsIn("Final")).toContain(subject);
    expect(await subjectsIn("Middle")).not.toContain(subject);

    const [row] = await ctx.pgSql<{ imap_uid: string | null }[]>`
      SELECT imap_uid FROM messages WHERE id = ${id}
    `;
    // The server's real UID is written back, so the row is usable again rather than
    // stranded mid-move.
    expect(row.imap_uid).not.toBeNull();

    const dead = await ctx.pgSql`
      SELECT id FROM sync_queue WHERE account_id = ${ctx.accountId} AND status = 'dead'
    `;
    expect(dead).toHaveLength(0);
  });

  test("moved then deleted, the message is gone from every folder", async () => {
    const subject = `Doomed ${randomUUID().slice(0, 8)}`;
    const { id, uid } = await seedMessage(subject);

    await ctx.pgSql`
      UPDATE messages SET folder_id = ${middleId}, imap_uid = NULL WHERE id = ${id}
    `;
    await ctx.pgSql`UPDATE messages SET expunged_at = now() WHERE id = ${id}`;

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    expect(await uidsIn("INBOX")).not.toContain(uid);
    expect(await subjectsIn("Middle")).not.toContain(subject);

    const dead = await ctx.pgSql`
      SELECT id FROM sync_queue WHERE account_id = ${ctx.accountId} AND status = 'dead'
    `;
    expect(dead).toHaveLength(0);
  });

  test("a move chain longer than one claim batch applies every hop", async () => {
    // BATCH_SIZE is 10, and coalescing only ever sees the entries of one claimed batch.
    // The 11th move's trigger fired on an already-nulled imap_uid, so its payload carries
    // no source UID and it can only be resolved from the row the earlier batch repaired.
    // Any bulk client-side refiling issues more than ten moves on one message routinely.
    const subject = `Long chain ${randomUUID().slice(0, 8)}`;
    const { id } = await seedMessage(subject);

    const hops = 11;
    for (let i = 0; i < hops; i++) {
      const destination = i % 2 === 0 ? middleId : finalId;
      await ctx.pgSql`
        UPDATE messages SET folder_id = ${destination}, imap_uid = NULL WHERE id = ${id}
      `;
    }

    const queued = await ctx.pgSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sync_queue
      WHERE account_id = ${ctx.accountId} AND action = 'move'
    `;
    expect(queued[0].n).toBe(hops);

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    // Odd hop count starting at Middle ends at Middle.
    expect(await subjectsIn("Middle")).toContain(subject);
    expect(await subjectsIn("Final")).not.toContain(subject);

    const dead = await ctx.pgSql`
      SELECT id, error FROM sync_queue WHERE account_id = ${ctx.accountId} AND status = 'dead'
    `;
    expect(dead).toHaveLength(0);

    const [row] = await ctx.pgSql<{ imap_uid: string | null }[]>`
      SELECT imap_uid FROM messages WHERE id = ${id}
    `;
    expect(row.imap_uid).not.toBeNull();
  });

  test("a move retried after a crash recovers the UID instead of reporting a silent success", async () => {
    // The crash window: the server-side MOVE ran, the process died before the write-back
    // recorded the new UID. On restart the entry is retried, and MOVE over a UID set that
    // matches nothing is not an error -- so without the reconciliation the retry reports
    // success, leaves imap_uid NULL forever, and strands the row permanently.
    const subject = `Crashed ${randomUUID().slice(0, 8)}`;
    const { id, uid } = await seedMessage(subject);

    await ctx.pgSql`
      UPDATE messages SET folder_id = ${middleId}, imap_uid = NULL WHERE id = ${id}
    `;

    // Stand in for the processor having claimed the entry and executed the IMAP move.
    await ctx.pgSql`
      UPDATE sync_queue SET status = 'processing'
      WHERE account_id = ${ctx.accountId} AND action = 'move' AND message_id = ${id}
    `;
    const mover = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const lock = await mover.getMailboxLock("INBOX");
      try {
        const moved = await moveMessage(mover, uid, "Middle", testCapabilities);
        expect(moved.success).toBe(true);
      } finally {
        lock.release();
      }
    } finally {
      await mover.logout();
    }

    await startupRecovery(ctx.db);
    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    const [row] = await ctx.pgSql<{ imap_uid: string | null }[]>`
      SELECT imap_uid FROM messages WHERE id = ${id}
    `;
    expect(row.imap_uid).not.toBeNull();

    // The recovered UID must be the one the message actually has in its new folder,
    // otherwise every later operation on this row names the wrong message.
    expect(await uidsIn("Middle")).toContain(Number(row.imap_uid));
    expect(await subjectsIn("Middle")).toContain(subject);
  });

  test("moved then flagged, the flag reaches the message in its new folder", async () => {
    const subject = `Flagged ${randomUUID().slice(0, 8)}`;
    const { id } = await seedMessage(subject);

    await ctx.pgSql`
      UPDATE messages SET folder_id = ${middleId}, imap_uid = NULL WHERE id = ${id}
    `;
    await ctx.pgSql`UPDATE messages SET is_flagged = true WHERE id = ${id}`;

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const lock = await client.getMailboxLock("Middle");
      try {
        let seen = false;
        for await (const msg of client.fetch({ all: true }, { envelope: true, flags: true })) {
          if (msg.envelope?.subject === subject) {
            seen = true;
            expect(msg.flags?.has("\\Flagged")).toBe(true);
          }
        }
        expect(seen).toBe(true);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    const dead = await ctx.pgSql`
      SELECT id FROM sync_queue WHERE account_id = ${ctx.accountId} AND status = 'dead'
    `;
    expect(dead).toHaveLength(0);
  });

  test("a move whose message is gone from the server does not claim the mirror was put back", async () => {
    // reverted_at means "PostIMAP re-read this from the server, what you see now is the
    // server's truth". Writing the pre-move UID back without checking would point the row
    // at a UID that names nothing while asserting exactly that.
    const subject = `Vanished ${randomUUID().slice(0, 8)}`;
    const { id, uid } = await seedMessage(subject);

    // Another client deletes it outright -- not a move, so it is in no folder at all.
    const other = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    try {
      const lock = await other.getMailboxLock("INBOX");
      try {
        await other.messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await other.logout();
    }

    await ctx.pgSql`
      UPDATE messages SET folder_id = ${middleId}, imap_uid = NULL WHERE id = ${id}
    `;
    // Straight to the terminal state rather than five rounds of backoff.
    await ctx.pgSql`
      UPDATE sync_queue SET attempts = max_attempts - 1
      WHERE message_id = ${id} AND action = 'move'
    `;

    await refreshSharedClient();
    await makeProcessor().drain(ctx.accountId);

    const [note] = await ctx.pgSql<{ action: string; reverted_at: Date | null }[]>`
      SELECT action, reverted_at FROM sync_notifications
      WHERE account_id = ${ctx.accountId} AND message_id = ${id}
    `;
    expect(note).toBeDefined();
    expect(note.action).toBe("move");
    expect(note.reverted_at).toBeNull();

    const [row] = await ctx.pgSql<{ imap_uid: string | null }[]>`
      SELECT imap_uid FROM messages WHERE id = ${id}
    `;
    expect(row.imap_uid).toBeNull();
  });
});
