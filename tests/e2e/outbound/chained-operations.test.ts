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

/** Deliver a message, let it reach PG, and hand back its row id and UID. */
async function seedMessage(subject: string): Promise<{ id: string; uid: number }> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  let uid: number;
  try {
    const before = (await client.status("INBOX", { messages: true })).messages ?? 0;
    await deliverTestEmail({
      from: ctx.testEmail,
      to: ctx.testEmail,
      subject,
      text: "chained",
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
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
    VALUES (${id}, ${ctx.accountId}, ${ctx.folderId}, ${String(uid)}, ${subject})
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
});
