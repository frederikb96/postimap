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

const MESSAGE_COUNT = 500;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-fullsync" });
  await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);

  // Append 500+ messages via IMAP APPEND (small messages for speed)
  const directClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  await appendBulkMessages(directClient, "INBOX", MESSAGE_COUNT, ["\\Seen"]);
  await directClient.logout();
}, 120_000);

afterAll(async () => {
  await teardownE2EContext(ctx);
});

describe("E2E: initial full sync of 500+ messages", () => {
  test("all messages appear in PG, count matches", async () => {
    const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
    const result = await inbound.fullSync(ctx.folderId, "INBOX");

    expect(result.errors).toEqual([]);
    expect(result.newMessages).toBe(MESSAGE_COUNT);

    await ctx.pgSql.unsafe(`SET search_path TO "${ctx.schema}", public`);
    const countRows = await ctx.pgSql`
        SELECT COUNT(*) as cnt FROM messages
        WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
      `;

    expect(Number(countRows[0].cnt)).toBe(MESSAGE_COUNT);

    const sampleRows = await ctx.pgSql`
        SELECT subject, from_addr, is_seen FROM messages
        WHERE folder_id = ${ctx.folderId} AND deleted_at IS NULL
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
});
