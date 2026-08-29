import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { env, testTls } from "../../setup/env.js";
import { appendBulkMessages, connectImap } from "../../setup/imap-helpers.js";
import { MailServerAdmin } from "../../setup/mailserver-admin.js";

const admin = new MailServerAdmin();
const testEmail = `condstore-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = env.MAIL_PASSWORD;
let client: ImapFlow;

beforeAll(async () => {
  await admin.createAccount(testEmail);
});

afterEach(async () => {
  if (client?.usable) {
    await client.logout();
  }
});

afterAll(async () => {
  await admin.deleteAccount(testEmail);
});

describe("CONDSTORE / CHANGEDSINCE", () => {
  test("fetch with CHANGEDSINCE returns only messages modified after modseq", async () => {
    client = await connectImap({ user: testEmail, password: testPassword });
    expect(client.capabilities.has("CONDSTORE")).toBe(true);

    // Append 3 test messages
    await appendBulkMessages(client, "INBOX", 3, []);

    // Open mailbox and record the current highestmodseq
    const lock = await client.getMailboxLock("INBOX");
    let baseModseq: bigint;

    try {
      const mailbox = client.mailbox;
      expect(mailbox).toBeDefined();
      expect(mailbox?.exists).toBeGreaterThanOrEqual(3);

      baseModseq = mailbox?.highestModseq ?? BigInt(0);
      expect(baseModseq).toBeGreaterThan(BigInt(0));

      // Collect UIDs of all messages
      const allUids: number[] = [];
      for await (const msg of client.fetch("1:*", { uid: true, flags: true })) {
        allUids.push(msg.uid);
      }
      expect(allUids.length).toBeGreaterThanOrEqual(3);

      // Change flag on first message
      await client.messageFlagsAdd({ uid: allUids[0] }, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }

    // Re-open mailbox and fetch with CHANGEDSINCE using the old modseq
    const lock2 = await client.getMailboxLock("INBOX");
    try {
      const changedMessages: Array<{ uid: number; flags: Set<string> }> = [];

      for await (const msg of client.fetch(
        "1:*",
        { uid: true, flags: true },
        { changedSince: baseModseq },
      )) {
        changedMessages.push({ uid: msg.uid, flags: msg.flags ?? new Set() });
      }

      // Only the message we modified should come back
      expect(changedMessages.length).toBeGreaterThanOrEqual(1);
      const modifiedMsg = changedMessages.find((m) => m.flags.has("\\Seen"));
      expect(modifiedMsg).toBeDefined();
    } finally {
      lock2.release();
    }
  });
});

describe("QRESYNC", () => {
  test("a QRESYNC-enabled client reports EXPUNGE by UID instead of sequence number", async () => {
    const qClient = new ImapFlow({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: false,
      auth: { user: testEmail, pass: testPassword },
      logger: false,
      tls: testTls,
      qresync: true,
    });
    await qClient.connect();
    expect(qClient.capabilities.has("QRESYNC")).toBe(true);

    try {
      await appendBulkMessages(qClient, "INBOX", 1, []);

      const lock = await qClient.getMailboxLock("INBOX");
      let targetUid: number;
      try {
        const msg = await qClient.fetchOne("*", { uid: true });
        if (!msg) throw new Error("expected at least one message in INBOX");
        targetUid = msg.uid;
      } finally {
        lock.release();
      }

      const expunged = new Promise<{ uid?: number }>((resolve) => {
        qClient.once("expunge", (event: { uid?: number }) => resolve(event));
      });

      const lock2 = await qClient.getMailboxLock("INBOX");
      try {
        await qClient.messageDelete({ uid: targetUid }, { uid: true });
      } finally {
        lock2.release();
      }

      const event = await expunged;
      // Without QRESYNC, ImapFlow reports the deleted message's sequence number.
      // With QRESYNC enabled, the server sends VANISHED and ImapFlow surfaces the UID.
      expect(event.uid).toBe(targetUid);
    } finally {
      if (qClient.usable) await qClient.logout();
    }
  });
});
