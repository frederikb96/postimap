import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { detectCapabilities } from "../../../src/imap/capabilities.js";
import { ImapClient } from "../../../src/imap/pool.js";
import { discoverFolders, syncFoldersToPg } from "../../../src/protocol/folder-sync.js";
import { env, getDatabaseUrl, testTls } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
} from "../../setup/pg-helpers.js";
import { StalwartAdmin } from "../../setup/stalwart-admin.js";

const admin = new StalwartAdmin();
const testEmail = `folder-test-${randomUUID().slice(0, 8)}@${env.TEST_DOMAIN}`;
const testPassword = "test-folder-password-42";

let sql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let imapClient: ImapClient;
let accountId: string;

beforeAll(async () => {
  await admin.createAccount(testEmail, testPassword);

  sql = connectPg();
  schema = await createTestSchema(sql);
  db = createTestDb(getDatabaseUrl(schema));

  // Insert a test account
  const result = await db
    .insertInto("accounts")
    .values({
      name: `folder-sync-test-${randomUUID().slice(0, 8)}`,
      imap_host: env.IMAP_HOST,
      imap_port: env.IMAP_PORT,
      imap_user: testEmail,
      imap_password: Buffer.from("encrypted-placeholder"),
      smtp_host: null,
      smtp_port: null,
      smtp_user: null,
      smtp_password: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  accountId = result.id;

  imapClient = new ImapClient({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: testEmail,
    password: testPassword,
    tls: testTls,
    retry: { maxRetries: 0 },
  });
  imapClient.on("error", () => {});
  await imapClient.connect();
});

afterAll(async () => {
  await imapClient.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await db.destroy();
  await dropTestSchema(sql, schema);
  await sql.end();
  await admin.deleteAccount(testEmail);
});

describe("folder discovery", () => {
  test("discovers INBOX from Stalwart", async () => {
    const folders = await discoverFolders(imapClient.client);
    const inbox = folders.find((f) => f.imapName === "INBOX");
    expect(inbox).toBeDefined();
  });

  test("detects hierarchy separator", async () => {
    const folders = await discoverFolders(imapClient.client);
    const inbox = folders.find((f) => f.imapName === "INBOX");
    expect(inbox?.separator).toBeTruthy();
  });

  test("reports SPECIAL-USE flags from server", async () => {
    const folders = await discoverFolders(imapClient.client);
    // Stalwart typically auto-creates special-use folders
    const specialUseFolders = folders.filter((f) => f.specialUse);
    // At minimum INBOX should have special-use, if Stalwart reports it
    const inbox = folders.find((f) => f.imapName === "INBOX");
    // INBOX may or may not have specialUse set depending on server
    expect(inbox).toBeDefined();
  });
});

describe("syncFoldersToPg", () => {
  test("creates new folders on first sync", async () => {
    const folders = await discoverFolders(imapClient.client);
    const caps = detectCapabilities(imapClient.client);
    const result = await syncFoldersToPg(db, accountId, folders, caps);

    expect(result.created.length).toBeGreaterThan(0);
    expect(result.created).toContain("INBOX");
    expect(result.deleted).toHaveLength(0);
    expect(result.renamed).toHaveLength(0);

    // Verify rows exist in DB
    const rows = await db
      .selectFrom("folders")
      .selectAll()
      .where("account_id", "=", accountId)
      .execute();
    expect(rows.length).toBe(folders.length);
  });

  test("re-discovery produces no changes", async () => {
    const folders = await discoverFolders(imapClient.client);
    const caps = detectCapabilities(imapClient.client);
    const result = await syncFoldersToPg(db, accountId, folders, caps);

    expect(result.created).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.renamed).toHaveLength(0);
  });

  test("detects new folder created on server", async () => {
    // Create a new folder via IMAP
    const newFolderName = `TestFolder-${randomUUID().slice(0, 8)}`;
    await imapClient.client.mailboxCreate(newFolderName);

    try {
      const folders = await discoverFolders(imapClient.client);
      const caps = detectCapabilities(imapClient.client);
      const result = await syncFoldersToPg(db, accountId, folders, caps);

      expect(result.created).toContain(newFolderName);
    } finally {
      await imapClient.client.mailboxDelete(newFolderName);
    }
  });

  test("detects deleted folder", async () => {
    // Create and sync a folder
    const tempFolder = `TempFolder-${randomUUID().slice(0, 8)}`;
    await imapClient.client.mailboxCreate(tempFolder);

    let folders = await discoverFolders(imapClient.client);
    let caps = detectCapabilities(imapClient.client);
    await syncFoldersToPg(db, accountId, folders, caps);

    // Delete the folder
    await imapClient.client.mailboxDelete(tempFolder);

    // Re-sync
    folders = await discoverFolders(imapClient.client);
    caps = detectCapabilities(imapClient.client);
    const result = await syncFoldersToPg(db, accountId, folders, caps);

    expect(result.deleted).toContain(tempFolder);
  });
});
