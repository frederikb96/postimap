import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { deliverTestEmail } from "../../setup/delivery-helpers.js";
import { env } from "../../setup/env.js";
import { connectImap } from "../../setup/imap-helpers.js";
import { MailServerAdmin } from "../../setup/mailserver-admin.js";

const admin = new MailServerAdmin();
const testEmail = `idle-test-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = env.MAIL_PASSWORD;
let client: ImapFlow;

beforeAll(async () => {
  await admin.createAccount(testEmail);
});

afterEach(async () => {
  if (client?.usable) {
    try {
      await client.logout();
    } catch {
      // Already closed
    }
  }
});

afterAll(async () => {
  await admin.deleteAccount(testEmail);
});

describe("IDLE notification", () => {
  test("IDLE reports EXISTS event when new email arrives", async () => {
    client = await connectImap({ user: testEmail, password: testPassword });
    expect(client.capabilities.has("IDLE")).toBe(true);

    // Open INBOX
    const lock = await client.getMailboxLock("INBOX");

    try {
      const initialExists = client.mailbox?.exists ?? 0;

      // Set up EXISTS event listener before starting IDLE
      const existsEvent = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("IDLE EXISTS event not received within 10s"));
        }, 10_000);

        client.on("exists", (event: { path: string; count: number; prevCount: number }) => {
          if (event.path === "INBOX" && event.count > initialExists) {
            clearTimeout(timeout);
            resolve(event.count);
          }
        });
      });

      // Start IDLE (runs in background while we deliver mail)
      const _idlePromise = client.idle();

      // Deliver email (slightly delayed to ensure IDLE is active)
      await new Promise((r) => setTimeout(r, 500));
      await deliverTestEmail({
        from: testEmail,
        to: testEmail,
        subject: `IDLE test ${randomUUID().slice(0, 8)}`,
        text: "Testing IDLE notification",
      });

      // Wait for EXISTS event
      const newCount = await existsEvent;
      expect(newCount).toBeGreaterThan(initialExists);

      // IDLE should eventually resolve after the notification
      // Break IDLE via NOOP (like the IdleWatcher does)
      await client.noop();
    } finally {
      lock.release();
    }
  });
});
