import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  emailWithAttachment,
  multipartHtmlEmail,
  simplePlainEmail,
  unicodeHeaderEmail,
} from "../../factories/mime.js";
import {
  appendBulkMessages,
  connectImap,
  type E2EContext,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-fullrepl" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

/**
 * Creates a dedicated IMAP mailbox + PG folder row for a test, so each test's message
 * count is isolated even though the account/schema/IMAP connection are shared.
 */
async function createIsolatedFolder(name: string): Promise<{ folderId: string; imapName: string }> {
  const setupClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    await setupClient.mailboxCreate(name);
  } finally {
    await setupClient.logout();
  }
  const folderId = randomUUID();
  await ctx.pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name)
    VALUES (${folderId}, ${ctx.accountId}, ${name}, ${name})
  `;
  return { folderId, imapName: name };
}

describe("E2E: full replication", () => {
  test("500+ messages: initial full sync, count matches, sample rows well-formed", async () => {
    const { folderId, imapName } = await createIsolatedFolder(
      `FullSync-${randomUUID().slice(0, 8)}`,
    );
    const MESSAGE_COUNT = 500;

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await appendBulkMessages(directClient, imapName, MESSAGE_COUNT, ["\\Seen"]);
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const result = await inbound.fullSync(folderId, imapName);

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBe(MESSAGE_COUNT);

    const countRows = await ctx.pgSql`
      SELECT COUNT(*) as cnt FROM messages WHERE folder_id = ${folderId} AND expunged_at IS NULL
    `;
    expect(Number(countRows[0].cnt)).toBe(MESSAGE_COUNT);

    const sampleRows = await ctx.pgSql`
      SELECT subject, from_addr, is_seen FROM messages
      WHERE folder_id = ${folderId} AND expunged_at IS NULL
      ORDER BY imap_uid::integer
      LIMIT 5
    `;
    expect(sampleRows).toHaveLength(5);
    for (const row of sampleRows) {
      expect(row.subject).toMatch(/^Bulk message \d+$/);
      expect(row.from_addr).toContain("@test.local");
      expect(row.is_seen).toBe(true);
    }
  }, 120_000);

  test("no NULL body_text across plain/HTML/attachment/unicode message variants", async () => {
    const { folderId, imapName } = await createIsolatedFolder(
      `BodyComplete-${randomUUID().slice(0, 8)}`,
    );
    const suffix = randomUUID().slice(0, 8);
    const MESSAGE_COUNT = 50;

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      let raw: string;
      const msgSuffix = `${suffix}-${i}`;
      switch (i % 4) {
        case 0:
          raw = simplePlainEmail({
            from: `sender-${i}@test.local`,
            to: ctx.testEmail,
            subject: `Plain ${msgSuffix}`,
            body: `Plain text body for message ${i}.\r\n`,
            messageId: `<plain-${msgSuffix}@test.local>`,
          });
          break;
        case 1:
          raw = multipartHtmlEmail({
            from: `sender-${i}@test.local`,
            to: ctx.testEmail,
            subject: `HTML ${msgSuffix}`,
            text: `Text part for message ${i}`,
            html: `<html><body><p>HTML body for message ${i}</p></body></html>`,
            messageId: `<html-${msgSuffix}@test.local>`,
          });
          break;
        case 2:
          raw = emailWithAttachment({
            from: `sender-${i}@test.local`,
            to: ctx.testEmail,
            subject: `Attach ${msgSuffix}`,
            text: `Attachment email body ${i}`,
            attachmentFilename: `file-${i}.txt`,
            attachmentBase64: Buffer.from(`Content of file ${i}`).toString("base64"),
            messageId: `<attach-${msgSuffix}@test.local>`,
          });
          break;
        default:
          raw = unicodeHeaderEmail();
          break;
      }
      await directClient.append(imapName, Buffer.from(raw), ["\\Seen"]);
    }
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const result = await inbound.fullSync(folderId, imapName);

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBe(MESSAGE_COUNT);

    const allRows = await ctx.pgSql`
      SELECT body_text, body_html, subject FROM messages
      WHERE folder_id = ${folderId} AND expunged_at IS NULL
    `;
    expect(allRows).toHaveLength(MESSAGE_COUNT);
    for (const row of allRows) {
      expect(row.body_text).toBeTruthy();
      expect(row.body_text.length).toBeGreaterThan(0);
    }

    // The jsonb columns must hold real JSON documents, not JSON-encoded strings.
    // A string here is queryable by nothing: no ->, ->>, @> or index operator
    // reaches inside it, which silently breaks every consumer that filters on
    // recipients or headers.
    const shapes = await ctx.pgSql`
      SELECT jsonb_typeof(to_addrs)    AS to_kind,
             jsonb_typeof(raw_headers) AS headers_kind,
             to_addrs #>> '{0}'         AS first_recipient
      FROM messages
      WHERE folder_id = ${folderId} AND expunged_at IS NULL AND to_addrs IS NOT NULL
      LIMIT 5
    `;
    expect(shapes.length).toBeGreaterThan(0);
    for (const row of shapes) {
      expect(row.to_kind).toBe("array");
      expect(row.headers_kind).toBe("object");
      expect(row.first_recipient).toBeTruthy();
    }
  }, 60_000);

  test("~10KB attachment stored in PG with correct size and data", async () => {
    const { folderId, imapName } = await createIsolatedFolder(`Attach-${randomUUID().slice(0, 8)}`);
    const suffix = randomUUID().slice(0, 8);

    const ATTACHMENT_SIZE = 10 * 1024;
    const attachmentData = Buffer.alloc(ATTACHMENT_SIZE);
    for (let i = 0; i < ATTACHMENT_SIZE; i++) {
      attachmentData[i] = i % 256;
    }
    const attachmentBase64 = attachmentData.toString("base64");
    const ATTACHMENT_FILENAME = "test-binary.dat";

    const boundary = "----=_Part_Attach_Test";
    const base64Lines = attachmentBase64.match(/.{1,76}/g) ?? [];
    const rawEmail = [
      "From: sender@test.local",
      `To: ${ctx.testEmail}`,
      `Subject: Attachment Test ${suffix}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <attach-test-${suffix}@test.local>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "This email has a binary attachment.",
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${ATTACHMENT_FILENAME}"`,
      `Content-Disposition: attachment; filename="${ATTACHMENT_FILENAME}"`,
      "Content-Transfer-Encoding: base64",
      "",
      ...base64Lines,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
    await directClient.append(imapName, Buffer.from(rawEmail), ["\\Seen"]);
    await directClient.logout();

    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const result = await inbound.fullSync(folderId, imapName);

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBe(1);

    const msgRows = await ctx.pgSql`
      SELECT id, subject, body_text FROM messages
      WHERE folder_id = ${folderId} AND expunged_at IS NULL
    `;
    expect(msgRows).toHaveLength(1);
    expect(msgRows[0].subject).toContain("Attachment Test");
    expect(msgRows[0].body_text).toContain("binary attachment");

    const attRows = await ctx.pgSql`
      SELECT filename, content_type, size_bytes, data
      FROM attachments
      WHERE message_id = ${msgRows[0].id}
    `;
    expect(attRows).toHaveLength(1);
    expect(attRows[0].filename).toBe(ATTACHMENT_FILENAME);
    expect(attRows[0].content_type).toBe("application/octet-stream");
    expect(attRows[0].size_bytes).toBe(ATTACHMENT_SIZE);

    const storedData = attRows[0].data as Buffer;
    expect(storedData.length).toBe(ATTACHMENT_SIZE);
    expect(Buffer.compare(storedData, attachmentData)).toBe(0);
  });
});
