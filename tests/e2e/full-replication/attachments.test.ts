import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  type E2EContext,
  connectImap,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

const suffix = randomUUID().slice(0, 8);

// Generate ~10KB of deterministic binary data for the attachment
const ATTACHMENT_SIZE = 10 * 1024;
const attachmentData = Buffer.alloc(ATTACHMENT_SIZE);
for (let i = 0; i < ATTACHMENT_SIZE; i++) {
  attachmentData[i] = i % 256;
}
const attachmentBase64 = attachmentData.toString("base64");
const ATTACHMENT_FILENAME = "test-binary.dat";

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-attach" });

  // Append message with ~10KB attachment
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
  await directClient.append("INBOX", Buffer.from(rawEmail), ["\\Seen"]);
  await directClient.logout();
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: attachment storage", () => {
  test("~10KB attachment stored in PG with correct size and data", async () => {
    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const result = await inbound.fullSync(ctx.folderId, "INBOX");

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBe(1);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const msgRows = await ctx.pgSql`
      SELECT id, subject, body_text FROM messages
      WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
    `;

    expect(msgRows).toHaveLength(1);
    expect(msgRows[0].subject).toContain("Attachment Test");
    expect(msgRows[0].body_text).toContain("binary attachment");

    const msgId = msgRows[0].id;

    const attRows = await ctx.pgSql`
      SELECT filename, content_type, size_bytes, data
      FROM attachments
      WHERE message_id = ${msgId}
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
