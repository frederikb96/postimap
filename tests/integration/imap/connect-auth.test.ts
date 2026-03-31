import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ImapClient } from "../../../src/imap/pool.js";
import { env, testTls } from "../../setup/env.js";
import { connectImap } from "../../setup/imap-helpers.js";
import { StalwartAdmin } from "../../setup/stalwart-admin.js";

const admin = new StalwartAdmin();
const testEmail = `connect-test-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = "test-connect-password-42";

// Track clients for cleanup
const activeClients: ImapClient[] = [];

beforeAll(async () => {
  await admin.createAccount(testEmail, testPassword);
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

function createTestClient(overrides?: Partial<Parameters<typeof ImapClient.prototype.connect>[0]>) {
  const client = new ImapClient({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: testEmail,
    password: testPassword,
    tls: testTls,
    retry: { maxRetries: 0, baseDelay: 100 },
    ...overrides,
  });
  // Suppress error events in tests (unhandled 'error' events throw)
  client.on("error", () => {});
  activeClients.push(client);
  return client;
}

describe("ImapClient connect/disconnect", () => {
  test("connects to Stalwart and reports connected", async () => {
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
