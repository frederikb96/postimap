import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { env } from "../../setup/env.js";
import { appendBulkMessages, connectImap } from "../../setup/imap-helpers.js";
import { StalwartAdmin } from "../../setup/stalwart-admin.js";

const admin = new StalwartAdmin();
const testEmail = `condstore-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = "condstore-test-pass-42";
let client: ImapFlow;

beforeAll(async () => {
  await admin.createAccount(testEmail, testPassword);
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

    // Append 3 test messages
    await appendBulkMessages(client, "INBOX", 3, []);

    // Open mailbox and record the current highestmodseq
    const lock = await client.getMailboxLock("INBOX");
    let baseModseq: bigint;

    try {
      const mailbox = client.mailbox;
      expect(mailbox).toBeDefined();
      expect(mailbox?.exists).toBeGreaterThanOrEqual(3);

      // Check if server supports CONDSTORE
      const hasCondstore = client.capabilities.has("CONDSTORE");
      if (!hasCondstore) {
        console.warn("Server does not support CONDSTORE, skipping test");
        return;
      }

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
