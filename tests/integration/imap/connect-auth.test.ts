import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ImapClient, type ImapClientOptions } from "../../../src/imap/pool.js";
import { env, testTls } from "../../setup/env.js";
import { connectImap } from "../../setup/imap-helpers.js";
import { MailServerAdmin } from "../../setup/mailserver-admin.js";
import { waitFor } from "../../setup/wait-for.js";

const admin = new MailServerAdmin();
const testEmail = `connect-test-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = env.MAIL_PASSWORD;

// Track clients for cleanup
const activeClients: ImapClient[] = [];

beforeAll(async () => {
  await admin.createAccount(testEmail);
});

afterEach(async () => {
  // Clean up all clients created in the test
  for (const client of activeClients) {
    await client.disconnect();
  }
  activeClients.length = 0;
  // Allow pending socket events to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  await admin.deleteAccount(testEmail);
});

function createTestClient(overrides?: Partial<ImapClientOptions>) {
  const client = new ImapClient({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: testEmail,
    password: testPassword,
    tls: testTls,
    retry: { maxRetries: 0, baseDelay: 100 },
    ...overrides,
  });
  activeClients.push(client);
  return client;
}

describe("ImapClient connect/disconnect", () => {
  test("connects to the mail server and reports connected", async () => {
    const client = createTestClient();
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  test("emits 'connected' event on successful connect", async () => {
    const client = createTestClient();
    const connected = new Promise<void>((resolve) => {
      client.on("connected", () => resolve());
    });
    await client.connect();
    await connected;
  });

  test("disconnect prevents auto-reconnect", async () => {
    const client = createTestClient();
    await client.connect();
    await client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.isConnected()).toBe(false);
  });

  test("exposes underlying ImapFlow client via getter", async () => {
    const client = createTestClient();
    await client.connect();
    const flow = client.client;
    expect(flow).toBeDefined();
    expect(flow.usable).toBe(true);
  });

  test("throws when accessing client before connect", () => {
    const client = createTestClient();
    expect(() => client.client).toThrow("not connected");
  });

  test("raw ImapFlow helper also works", async () => {
    const flow = await connectImap({ user: testEmail, password: testPassword });
    expect(flow.usable).toBe(true);
    await flow.logout();
  });
});

/** The socket under the client's current connection, to fail it the way a network does. */
function socketOf(client: ImapClient): Socket {
  return (client.client as unknown as { socket: Socket }).socket;
}

// Each failure reaches ImapFlow's error event from a socket callback, outside any promise a
// caller could catch -- so whatever handles that event decides whether the process survives.
// No test here listens for errors on the client, the same as production.
describe("ImapClient connection failures", () => {
  test("an idle socket timing out is survived, and the connection comes back", async () => {
    const client = createTestClient();
    await client.connect();
    const failed = client.client;

    socketOf(client).setTimeout(20);

    await waitFor(() => client.isConnected() && client.client !== failed, { timeout: 10_000 });
  });

  test("a socket read timing out is survived, and the connection comes back", async () => {
    const client = createTestClient();
    await client.connect();
    const failed = client.client;

    const timedOut = Object.assign(new Error("read ETIMEDOUT"), {
      code: "ETIMEDOUT",
      syscall: "read",
    });
    socketOf(client).destroy(timedOut);

    await waitFor(() => client.isConnected() && client.client !== failed, { timeout: 10_000 });
  });

  test("a failed connect leaves no reconnect running behind it", async () => {
    // Nothing listens on port 1, so the connection is refused the way a down server refuses it.
    const client = createTestClient({
      host: "127.0.0.1",
      port: 1,
      retry: { maxRetries: 2, baseDelay: 10 },
    });
    const connect = vi.spyOn(client, "connect");

    await expect(client.connect()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
