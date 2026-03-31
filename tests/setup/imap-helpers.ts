import { ImapFlow } from "imapflow";
import { env, testTls } from "./env.js";

export interface ImapConnectOptions {
  user: string;
  password: string;
  host?: string;
  port?: number;
}

/**
 * Create and connect an ImapFlow client to the test Stalwart server.
 */
export async function connectImap(opts: ImapConnectOptions): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: opts.host ?? env.IMAP_HOST,
    port: opts.port ?? env.IMAP_PORT,
    secure: false,
    auth: { user: opts.user, pass: opts.password },
    logger: false,
    tls: testTls,
  });

  await client.connect();
  return client;
}

export interface FetchedMessage {
  uid: number;
  flags: Set<string>;
  envelope: {
    subject?: string;
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    date?: Date;
    messageId?: string;
  };
  source?: Buffer;
}

/**
 * Fetch a single message by UID from the currently selected mailbox.
 */
export async function fetchImapMessage(client: ImapFlow, uid: number): Promise<FetchedMessage> {
  const msg = await client.fetchOne(String(uid), {
    uid: true,
    flags: true,
    envelope: true,
    source: true,
  });

  if (!msg) {
    throw new Error(`Message UID ${uid} not found`);
  }

  return {
    uid: msg.uid,
    flags: msg.flags ?? new Set<string>(),
    envelope: msg.envelope ?? {},
    source: msg.source,
  };
}

/**
 * Assert that a message's flags match the expected set.
 */
export function verifyImapFlags(actual: Set<string>, expectedFlags: string[]): boolean {
  const expected = new Set(expectedFlags);
  if (actual.size !== expected.size) return false;
  for (const flag of expected) {
    if (!actual.has(flag)) return false;
  }
  return true;
}

/**
 * Append multiple raw messages to a mailbox via IMAP APPEND.
 * Faster than SMTP delivery for bulk seeding.
 */
export async function appendBulkMessages(
  client: ImapFlow,
  folder: string,
  count: number,
  flags: string[] = ["\\Seen"],
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const raw = Buffer.from(
      `From: bulk-${i}@test.local\r\nTo: test@test.local\r\nSubject: Bulk message ${i}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <bulk-${i}-${Date.now()}@test.local>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of bulk message ${i}\r\n`,
    );
    await client.append(folder, raw, flags);
  }
}
