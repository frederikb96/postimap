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
  type E2EContext,
  connectImap,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

const suffix = randomUUID().slice(0, 8);
const MESSAGE_COUNT = 50;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-bodycomp" });
  await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);

  // Append 50 varied messages: mix of plain, HTML, attachment, unicode
  const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });

  for (let i = 0; i < MESSAGE_COUNT; i++) {
    let raw: string;
    const variant = i % 4;
    const msgSuffix = `${suffix}-${i}`;

    switch (variant) {
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

    await directClient.append("INBOX", Buffer.from(raw), ["\\Seen"]);
  }

  await directClient.logout();
}, 60_000);

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: body completeness on varied messages", () => {
  test("no NULL body_text on any synced message", async () => {
    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const result = await inbound.fullSync(ctx.folderId, "INBOX");

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBe(MESSAGE_COUNT);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const nullBodyRows = await ctx.pgSql`
        SELECT id, subject FROM messages
        WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL AND body_text IS NULL
      `;

    expect(nullBodyRows).toHaveLength(0);

    const allRows = await ctx.pgSql`
        SELECT body_text, body_html, subject FROM messages
        WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
      `;

    expect(allRows).toHaveLength(MESSAGE_COUNT);
    for (const row of allRows) {
      expect(row.body_text).toBeTruthy();
      expect(row.body_text.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
