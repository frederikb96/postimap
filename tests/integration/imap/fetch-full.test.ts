import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { env } from "../../setup/env.js";
import { connectImap } from "../../setup/imap-helpers.js";
import { deliverTestEmail } from "../../setup/smtp-helpers.js";
import { StalwartAdmin } from "../../setup/stalwart-admin.js";
import { waitFor } from "../../setup/wait-for.js";

const admin = new StalwartAdmin();
const testEmail = `fetch-full-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = "fetch-full-test-pass-42";
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

describe("fetch full message (envelope + source)", () => {
  test("delivered email can be fetched with correct subject, from, body", async () => {
    const uniqueSubject = `Fetch Test ${randomUUID().slice(0, 8)}`;
    const bodyText = "This is the body for the fetch-full integration test.";

    await deliverTestEmail({
      from: testEmail,
      to: testEmail,
      subject: uniqueSubject,
      text: bodyText,
      auth: { user: testEmail, pass: testPassword },
    });

    client = await connectImap({ user: testEmail, password: testPassword });

    // Wait for message to appear in INBOX
    await waitFor(
      async () => {
        const lock = await client.getMailboxLock("INBOX");
        try {
          return client.mailbox && client.mailbox.exists > 0;
        } finally {
          lock.release();
        }
      },
      { timeout: 10_000, interval: 500 },
    );

    const lock = await client.getMailboxLock("INBOX");
    try {
      // Fetch the message
      let found = false;
      for await (const msg of client.fetch("1:*", {
        uid: true,
        envelope: true,
        source: true,
        flags: true,
      })) {
        if (msg.envelope?.subject === uniqueSubject) {
          found = true;

          // Verify envelope fields
          expect(msg.envelope.subject).toBe(uniqueSubject);
          expect(msg.envelope.from?.[0]?.address).toBe(testEmail);

          // Verify source contains the body
          expect(msg.source).toBeDefined();
          const sourceStr = msg.source?.toString();
          expect(sourceStr).toContain(bodyText);
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      lock.release();
    }
  });
});
