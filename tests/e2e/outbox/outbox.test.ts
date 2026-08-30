import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import { OutboxProcessor } from "../../../src/sync/outbox.js";
import {
  clearMailpitMessages,
  connectImap,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
  waitForMailpitMessage,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-outbox", smtp: true });

  // Sent/Drafts don't exist on a fresh test mailbox -- create them and register the
  // special_use the way a real server's SPECIAL-USE-aware LIST/folder-sync would.
  const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    await setupClient.mailboxCreate("Sent");
    await setupClient.mailboxCreate("Drafts");
  } finally {
    await setupClient.logout();
  }
  await ctx.pgSql`
    INSERT INTO folders (account_id, imap_name, display_name, special_use)
    VALUES (${ctx.accountId}, 'Sent', 'Sent', 'sent'), (${ctx.accountId}, 'Drafts', 'Drafts', 'drafts')
  `;
});

afterEach(async () => {
  await clearMailpitMessages();
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

function makeProcessor(): OutboxProcessor {
  return new OutboxProcessor(
    ctx.db,
    getDatabaseUrl(ctx.schema),
    () => ctx.imapClient,
    60_000,
    undefined,
  );
}

function makeOutboundProcessor(): OutboundProcessor {
  return new OutboundProcessor(
    ctx.db,
    getDatabaseUrl(ctx.schema),
    () => ctx.imapClient,
    async () => testCapabilities,
    60_000,
    5,
  );
}

async function folderMessageCount(imapName: string): Promise<number> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    const status = await client.status(imapName, { messages: true });
    return status.messages ?? 0;
  } finally {
    await client.logout();
  }
}

describe("E2E: outbox send (PG -> SMTP + Sent APPEND)", () => {
  test("a pending send row is composed, delivered to SMTP, appended to Sent, and marked sent", async () => {
    const subject = `Outbox send ${randomUUID().slice(0, 8)}`;
    const sentBefore = await folderMessageCount("Sent");

    const outboxId = randomUUID();
    await ctx.pgSql`
      INSERT INTO outbox (id, account_id, kind, to_addrs, subject, body_text)
      VALUES (${outboxId}, ${ctx.accountId}, 'send', '["recipient@test.local"]',
        ${subject}, 'Hello from the outbox e2e test.')
    `;

    const processed = await makeProcessor().drain(ctx.accountId);
    expect(processed).toBe(1);

    const row =
      await ctx.pgSql`SELECT status, error, sent_message_id, sent_at FROM outbox WHERE id = ${outboxId}`;
    expect(row[0].status).toBe("sent");
    expect(row[0].error).toBeNull();
    expect(row[0].sent_message_id).toBeTruthy();
    expect(row[0].sent_at).not.toBeNull();

    // Proof of a real send: Mailpit is a genuine SMTP server, not a mock.
    const delivered = await waitForMailpitMessage(subject);
    expect(delivered.To[0].Address).toBe("recipient@test.local");
    expect(delivered.Text.trim()).toBe("Hello from the outbox e2e test.");

    const sentAfter = await folderMessageCount("Sent");
    expect(sentAfter).toBe(sentBefore + 1);

    // The appended copy flows through the same inbound path as any other message,
    // including thread_id assignment.
    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const sentFolder =
      await ctx.pgSql`SELECT id FROM folders WHERE account_id = ${ctx.accountId} AND imap_name = 'Sent'`;
    const syncResult = await inbound.syncFolder(sentFolder[0].id, "Sent");
    expect(syncResult.errors).toEqual([]);

    const stored =
      await ctx.pgSql`SELECT subject, thread_id FROM messages WHERE subject = ${subject}`;
    expect(stored).toHaveLength(1);
    expect(stored[0].thread_id).toBeTruthy();
  });

  test("a draft row skips SMTP and appends to Drafts only", async () => {
    const subject = `Outbox draft ${randomUUID().slice(0, 8)}`;
    const draftsBefore = await folderMessageCount("Drafts");

    const outboxId = randomUUID();
    await ctx.pgSql`
      INSERT INTO outbox (id, account_id, kind, to_addrs, subject, body_text)
      VALUES (${outboxId}, ${ctx.accountId}, 'draft', '["recipient@test.local"]',
        ${subject}, 'Draft body, never sent.')
    `;

    const processed = await makeProcessor().drain(ctx.accountId);
    expect(processed).toBe(1);

    const row = await ctx.pgSql`SELECT status, sent_at FROM outbox WHERE id = ${outboxId}`;
    expect(row[0].status).toBe("sent");
    expect(row[0].sent_at).toBeNull();

    const draftsAfter = await folderMessageCount("Drafts");
    expect(draftsAfter).toBe(draftsBefore + 1);

    // Nothing reached Mailpit for a draft.
    await expect(waitForMailpitMessage(subject, 1_500)).rejects.toThrow(/timed out/);
  });

  test("editing a draft replaces it instead of accumulating a copy per save", async () => {
    const firstSubject = `Outbox draft edit A ${randomUUID().slice(0, 8)}`;
    const secondSubject = `Outbox draft edit B ${randomUUID().slice(0, 8)}`;
    const draftsBefore = await folderMessageCount("Drafts");
    const draftsFolder =
      await ctx.pgSql`SELECT id FROM folders WHERE account_id = ${ctx.accountId} AND imap_name = 'Drafts'`;
    const draftsFolderId = draftsFolder[0].id;
    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);

    await ctx.pgSql`
      INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text)
      VALUES (${ctx.accountId}, 'draft', '["recipient@test.local"]',
        ${firstSubject}, 'First version.')
    `;
    expect(await makeProcessor().drain(ctx.accountId)).toBe(1);
    await inbound.syncFolder(draftsFolderId, "Drafts");

    const original =
      await ctx.pgSql`SELECT id FROM messages WHERE subject = ${firstSubject} AND expunged_at IS NULL`;
    expect(original).toHaveLength(1);

    // The edit: a new draft naming the one it supersedes.
    await ctx.pgSql`
      INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text, replaces_message_id)
      VALUES (${ctx.accountId}, 'draft', '["recipient@test.local"]',
        ${secondSubject}, 'Second version.', ${original[0].id})
    `;
    expect(await makeProcessor().drain(ctx.accountId)).toBe(1);

    // Appended first, so the replacement exists before anything is removed.
    expect(await folderMessageCount("Drafts")).toBe(draftsBefore + 2);

    const marked = await ctx.pgSql`SELECT expunged_at FROM messages WHERE id = ${original[0].id}`;
    expect(marked[0].expunged_at).not.toBeNull();

    // The removal rides the ordinary outbound delete path rather than a second mechanism
    // of its own -- which is what gives it retries and a notification when it fails.
    const queued = await ctx.pgSql`
      SELECT action, status FROM sync_queue WHERE message_id = ${original[0].id}
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0].action).toBe("delete");

    await makeOutboundProcessor().drain(ctx.accountId);

    // Net effect of an edit: one draft where there was one, not two.
    expect(await folderMessageCount("Drafts")).toBe(draftsBefore + 1);

    await inbound.syncFolder(draftsFolderId, "Drafts");
    const live = await ctx.pgSql`
      SELECT subject FROM messages
      WHERE folder_id = ${draftsFolderId} AND expunged_at IS NULL
        AND subject IN (${firstSubject}, ${secondSubject})
    `;
    expect(live.map((r: { subject: string }) => r.subject)).toEqual([secondSubject]);
  });

  test("a supersede naming another account's message leaves it alone", async () => {
    // The second account gets its own drafts folder so its entry genuinely completes --
    // an entry that dead-letters first would never reach the supersede at all, and the
    // assertion below would hold whether or not the account scoping exists.
    const otherAccount = randomUUID();
    await ctx.pgSql`
      INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password)
      VALUES (${otherAccount}, 'other', 'imap.invalid', 993, 'other@test.local',
        ${Buffer.from([0x00])})
    `;
    await ctx.pgSql`
      INSERT INTO folders (account_id, imap_name, display_name, special_use)
      VALUES (${otherAccount}, 'Drafts', 'Drafts', 'drafts')
    `;

    // A message of the first account's own, created here rather than borrowed from an
    // earlier test, so this test states its own preconditions.
    const victimSubject = `Outbox bystander ${randomUUID().slice(0, 8)}`;
    await ctx.pgSql`
      INSERT INTO outbox (account_id, kind, to_addrs, subject, body_text)
      VALUES (${ctx.accountId}, 'draft', '["recipient@test.local"]', ${victimSubject}, 'Bystander.')
    `;
    expect(await makeProcessor().drain(ctx.accountId)).toBe(1);
    const draftsFolder =
      await ctx.pgSql`SELECT id FROM folders WHERE account_id = ${ctx.accountId} AND imap_name = 'Drafts'`;
    await new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities).syncFolder(
      draftsFolder[0].id,
      "Drafts",
    );

    const victim = await ctx.pgSql`
      SELECT id FROM messages
      WHERE account_id = ${ctx.accountId} AND subject = ${victimSubject} AND expunged_at IS NULL
    `;
    expect(victim).toHaveLength(1);

    const subject = `Outbox cross-account ${randomUUID().slice(0, 8)}`;
    const outboxId = randomUUID();
    await ctx.pgSql`
      INSERT INTO outbox (id, account_id, kind, to_addrs, subject, body_text, replaces_message_id)
      VALUES (${outboxId}, ${otherAccount}, 'draft', '["recipient@test.local"]', ${subject}, 'x',
        ${victim[0].id})
    `;
    expect(await makeProcessor().drain(otherAccount)).toBe(1);

    const completed = await ctx.pgSql`SELECT status FROM outbox WHERE id = ${outboxId}`;
    expect(completed[0].status).toBe("sent");

    const untouched = await ctx.pgSql`SELECT expunged_at FROM messages WHERE id = ${victim[0].id}`;
    expect(untouched[0].expunged_at).toBeNull();

    await ctx.pgSql`DELETE FROM accounts WHERE id = ${otherAccount}`;
  });

  test("attachments round-trip through the composed MIME message", async () => {
    const subject = `Outbox attachment ${randomUUID().slice(0, 8)}`;
    const outboxId = randomUUID();
    await ctx.pgSql`
      INSERT INTO outbox (id, account_id, kind, to_addrs, subject, body_text)
      VALUES (${outboxId}, ${ctx.accountId}, 'send', '["recipient@test.local"]',
        ${subject}, 'See attached.')
    `;
    await ctx.pgSql`
      INSERT INTO outbox_attachments (outbox_id, filename, content_type, data)
      VALUES (${outboxId}, 'note.txt', 'text/plain', ${Buffer.from("attachment contents")})
    `;

    const processed = await makeProcessor().drain(ctx.accountId);
    expect(processed).toBe(1);

    const delivered = await waitForMailpitMessage(subject);
    expect(delivered.Attachments).toHaveLength(1);
    expect(delivered.Attachments[0].FileName).toBe("note.txt");
  });

  test("a send with no SMTP settings on the account is dead-lettered, not retried forever", async () => {
    const noSmtpCtx = await setupE2EContext({ emailPrefix: "e2e-outbox-nosmtp" });
    try {
      const outboxId = randomUUID();
      await noSmtpCtx.pgSql`
        INSERT INTO outbox (id, account_id, kind, to_addrs, subject, body_text, max_attempts)
        VALUES (${outboxId}, ${noSmtpCtx.accountId}, 'send', '["recipient@test.local"]',
          'No SMTP configured', 'This account has no smtp_host.', 1)
      `;

      const processor = new OutboxProcessor(
        noSmtpCtx.db,
        getDatabaseUrl(noSmtpCtx.schema),
        () => noSmtpCtx.imapClient,
        60_000,
        undefined,
      );
      await processor.drain(noSmtpCtx.accountId);

      const row = await noSmtpCtx.pgSql`SELECT status, error FROM outbox WHERE id = ${outboxId}`;
      expect(row[0].status).toBe("dead");
      expect(row[0].error).toMatch(/SMTP/i);
    } finally {
      await teardownE2EContext(noSmtpCtx);
    }
  });
});
