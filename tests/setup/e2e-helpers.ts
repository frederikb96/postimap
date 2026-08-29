import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { encryptPassword } from "../../src/crypto.js";
import type { Database } from "../../src/db/schema.js";
import { ImapClient } from "../../src/imap/pool.js";
import { env, getDatabaseUrl, testTls } from "./env.js";
import { MailServerAdmin } from "./mailserver-admin.js";
import { connectPg, createTestDb, createTestSchema, dropTestSchema } from "./pg-helpers.js";

export interface E2EContext {
  pgSql: postgres.Sql;
  schema: string;
  db: Kysely<Database>;
  imapClient: ImapClient;
  admin: MailServerAdmin;
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
  /**
   * Point the account's smtp_* columns at the test Mailpit instance, exercising the
   * same credential-decrypt path as imap_password. Mailpit accepts any SMTP AUTH
   * credentials, so the value only needs to round-trip, not actually authenticate.
   */
  smtp?: boolean;
}

/**
 * Creates a fully isolated E2E test context:
 * PG schema with migrations, test mailbox, PG account row (UUID), folder row, IMAP connection.
 */
export async function setupE2EContext(opts?: SetupE2EOptions): Promise<E2EContext> {
  const prefix = opts?.emailPrefix ?? "e2e";
  const folderImapName = opts?.folderImapName ?? "INBOX";

  const admin = new MailServerAdmin();
  const suffix = randomUUID().slice(0, 8);
  const testEmail = `${prefix}-${suffix}@${env.TEST_DOMAIN}`;
  const testPassword = env.MAIL_PASSWORD;
  const accountId = randomUUID();
  const folderId = randomUUID();

  await admin.createAccount(testEmail);

  const bootstrapSql = connectPg();
  const schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  const pgSql = connectPg(schema);
  const db = createTestDb(getDatabaseUrl(schema));

  const smtpColumns = opts?.smtp
    ? {
        smtp_host: env.MAILPIT_HOST,
        smtp_port: env.MAILPIT_SMTP_PORT,
        smtp_user: testEmail,
        smtp_password: encryptPassword(testPassword),
      }
    : { smtp_host: null, smtp_port: null, smtp_user: null, smtp_password: null };

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (
      ${accountId}, ${testEmail}, ${env.IMAP_HOST}, ${env.IMAP_PORT},
      ${testEmail}, ${encryptPassword(testPassword)},
      ${smtpColumns.smtp_host}, ${smtpColumns.smtp_port}, ${smtpColumns.smtp_user},
      ${smtpColumns.smtp_password},
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
 * Tears down an E2E context: drops PG schema, wipes the test mailbox, disconnects IMAP.
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

export {
  type ChaosContext,
  createImapProxy,
  createToxiproxyClient,
  type ToxiProxy,
} from "./chaos-helpers.js";
export { deliverAndWait, deliverTestEmail } from "./delivery-helpers.js";
export { env, getDatabaseUrl, testCapabilities, testTls } from "./env.js";
export { appendBulkMessages, connectImap } from "./imap-helpers.js";
export {
  clearMailpitMessages,
  getMailpitMessage,
  listMailpitMessages,
  type MailpitMessage,
  waitForMailpitMessage,
} from "./mailpit-helpers.js";
export { MailServerAdmin } from "./mailserver-admin.js";
export { connectPg, createTestDb, createTestSchema, dropTestSchema } from "./pg-helpers.js";
export { waitFor, waitForNotify } from "./wait-for.js";
