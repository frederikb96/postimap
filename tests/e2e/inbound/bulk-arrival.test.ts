import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  type E2EContext,
  appendBulkMessages,
  connectImap,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

const BULK_COUNT = 120;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-bulk" });

  // Append bulk messages via IMAP APPEND (faster than SMTP)
  const appendClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  await appendBulkMessages(appendClient, "INBOX", BULK_COUNT, ["\\Seen"]);
  await appendClient.logout();
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: bulk arrival inbound sync", () => {
  test(`syncs ${BULK_COUNT}+ messages into PG with no NULL body_text`, async () => {
    const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);

    const result = await sync.syncFolder(ctx.folderId, "INBOX");
    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBeGreaterThanOrEqual(BULK_COUNT);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const rows = await ctx.pgSql`
      SELECT id, subject, body_text, is_seen FROM messages
      WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
    `;

    expect(rows.length).toBeGreaterThanOrEqual(BULK_COUNT);

    const nullBodies = rows.filter((r) => r.body_text === null);
    expect(nullBodies).toHaveLength(0);

    const unseenCount = rows.filter((r) => !r.is_seen).length;
    expect(unseenCount).toBe(0);

    const bulkSubjects = rows.filter((r) => r.subject?.startsWith("Bulk message"));
    expect(bulkSubjects.length).toBeGreaterThanOrEqual(BULK_COUNT);
  });
});
