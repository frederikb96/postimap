import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { ImapClient } from "../../../src/imap/pool.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  StalwartAdmin,
  connectImap,
  connectPg,
  createTestDb,
  createTestSchema,
  deliverAndWait,
  dropTestSchema,
  env,
  getDatabaseUrl,
  testCapabilities,
  testTls,
} from "../../setup/e2e-helpers.js";

const admin = new StalwartAdmin();
const testEmail = `e2e-outmove-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = "e2e-outmove-pass-42";
const accountId = randomUUID();
const inboxFolderId = randomUUID();
const trashFolderId = randomUUID();

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let imapClient: ImapClient;

beforeAll(async () => {
  await admin.createAccount(testEmail, testPassword);

  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (
      ${accountId}, ${testEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${testEmail}, ${Buffer.from(testPassword)},
      ${env.SMTP_HOST}, ${env.SMTP_PORT}, ${testEmail}, ${Buffer.from(testPassword)},
      true, 'active'
    )
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${inboxFolderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${trashFolderId}, ${accountId}, 'Deleted Items', 'Deleted Items', 'trash')
  `;

  imapClient = new ImapClient({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: testEmail,
    password: testPassword,
    tls: testTls,
    retry: { maxRetries: 0, baseDelay: 100 },
  });
  imapClient.on("error", () => {});
  await imapClient.connect();
});

afterAll(async () => {
  if (imapClient?.isConnected()) await imapClient.disconnect();
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
  await admin.deleteAccount(testEmail);
});

describe("E2E: outbound move sync (PG -> IMAP)", () => {
  test("updating folder_id in PG moves message on IMAP", async () => {
    const uniqueSubject = `OutMove ${randomUUID().slice(0, 8)}`;

    const checkClient = await connectImap({ user: testEmail, password: testPassword });
    let imapUid: number;
    try {
      await deliverAndWait({
        from: testEmail,
        to: testEmail,
        subject: uniqueSubject,
        text: "Body for outbound move test.",
        auth: { user: testEmail, pass: testPassword },
        imapClient: checkClient,
      });

      const inboxLock = await checkClient.getMailboxLock("INBOX");
      try {
        const uids = await checkClient.search({ all: true }, { uid: true });
        expect(uids).not.toBe(false);
        imapUid = (uids as number[])[0];
      } finally {
        inboxLock.release();
      }
    } finally {
      await checkClient.logout();
    }

    await pgSql.unsafe(`SET search_path TO "${schema}", public`);
    const msgId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, sync_version)
      VALUES (${msgId}, ${accountId}, ${inboxFolderId}, ${String(imapUid)},
        ${uniqueSubject}, '1')
    `;

    // App-level move: change folder_id from INBOX to Trash
    await pgSql`UPDATE messages SET folder_id = ${trashFolderId} WHERE id = ${msgId}`;

    const queueRows = await pgSql`
      SELECT action, payload FROM sync_queue WHERE message_id = ${msgId}
    `;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].action).toBe("move");

    const processor = new OutboundProcessor(
      db,
      getDatabaseUrl(schema),
      () => imapClient,
      async () => testCapabilities,
      60_000,
      5,
    );

    await processor.drain(accountId);

    const verifyClient = await connectImap({ user: testEmail, password: testPassword });
    try {
      const inboxLock2 = await verifyClient.getMailboxLock("INBOX");
      try {
        const inboxUids = await verifyClient.search({ all: true }, { uid: true });
        if (inboxUids !== false) {
          expect(inboxUids).not.toContain(imapUid);
        }
      } finally {
        inboxLock2.release();
      }

      const trashLock = await verifyClient.getMailboxLock("Deleted Items");
      try {
        const trashUids = await verifyClient.search({ all: true }, { uid: true });
        expect(trashUids).not.toBe(false);
        expect((trashUids as number[]).length).toBeGreaterThanOrEqual(1);
      } finally {
        trashLock.release();
      }
    } finally {
      await verifyClient.logout();
    }
  });
});
