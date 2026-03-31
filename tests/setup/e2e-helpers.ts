import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import type { Database } from "../../src/db/schema.js";
import type { ServerCapabilities } from "../../src/imap/capabilities.js";
import { ImapClient } from "../../src/imap/pool.js";
import { env, getDatabaseUrl, testCapabilities, testTls } from "./env.js";
import { connectPg, createTestDb, createTestSchema, dropTestSchema } from "./pg-helpers.js";
import { StalwartAdmin } from "./stalwart-admin.js";

export interface E2EContext {
  pgSql: postgres.Sql;
  schema: string;
  db: Kysely<Database>;
  imapClient: ImapClient;
  admin: StalwartAdmin;
  testEmail: string;
  testPassword: string;
  accountId: string;
  folderId: string;
  folderImapName: string;
}

export interface SetupE2EOptions {
  /** Skip IMAP client creation (for tests that manage their own connections) */
  skipImap?: boolean;
  /** Custom email prefix (defaults to "e2e") */
  emailPrefix?: string;
  /** Custom folder IMAP name (defaults to "INBOX") */
  folderImapName?: string;
}

/**
 * Creates a fully isolated E2E test context:
 * PG schema with migrations, Stalwart account, PG account row (UUID), folder row, IMAP connection.
 */
export async function setupE2EContext(opts?: SetupE2EOptions): Promise<E2EContext> {
  const prefix = opts?.emailPrefix ?? "e2e";
  const folderImapName = opts?.folderImapName ?? "INBOX";

  const admin = new StalwartAdmin();
  const suffix = randomUUID().slice(0, 8);
  const testEmail = `${prefix}-${suffix}@${env.TEST_DOMAIN}`;
  const testPassword = `${prefix}-pass-${suffix}`;
  const accountId = randomUUID();
  const folderId = randomUUID();

  await admin.createAccount(testEmail, testPassword);

  const bootstrapSql = connectPg();
  const schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  const pgSql = connectPg(schema);
  const db = createTestDb(getDatabaseUrl(schema));

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
    VALUES (${folderId}, ${accountId}, ${folderImapName},
      ${folderImapName === "INBOX" ? "Inbox" : folderImapName},
      ${folderImapName === "INBOX" ? "inbox" : null})
  `;

  let imapClient: ImapClient;
  if (opts?.skipImap) {
    // Provide a placeholder that tests can replace
    imapClient = null as unknown as ImapClient;
  } else {
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
  }

  return {
    pgSql,
    schema,
    db,
    imapClient,
    admin,
    testEmail,
    testPassword,
    accountId,
    folderId,
    folderImapName,
  };
}

/**
 * Tears down an E2E context: drops PG schema, deletes Stalwart account, disconnects IMAP.
 */
export async function teardownE2EContext(ctx: E2EContext): Promise<void> {
  if (ctx.imapClient?.isConnected?.()) {
    await ctx.imapClient.disconnect();
  }
  if (ctx.db) {
    await ctx.db.destroy();
  }
  if (ctx.pgSql && ctx.schema) {
    await dropTestSchema(ctx.pgSql, ctx.schema);
    await ctx.pgSql.end();
  }
  await ctx.admin.deleteAccount(ctx.testEmail);
}

export { testCapabilities, testTls, getDatabaseUrl, env } from "./env.js";
export { connectPg, createTestDb, createTestSchema, dropTestSchema } from "./pg-helpers.js";
export { connectImap, appendBulkMessages } from "./imap-helpers.js";
export { deliverTestEmail, deliverAndWait } from "./smtp-helpers.js";
export { StalwartAdmin } from "./stalwart-admin.js";
export { waitFor, waitForNotify } from "./wait-for.js";
export {
  createToxiproxyClient,
  createImapProxy,
  type ChaosContext,
  type ToxiProxy,
} from "./chaos-helpers.js";
