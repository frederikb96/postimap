import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectPg,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";

let pgSql: postgres.Sql;
let listenerSql: postgres.Sql;
let schema: string;
let accountId: string;
let folderId: string;
let messageId: string;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  // Separate connection for LISTEN (pg requires dedicated connection for LISTEN)
  listenerSql = connectPg(schema);
});

afterAll(async () => {
  if (listenerSql) await listenerSql.end();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

beforeEach(async () => {
  await truncateAll(pgSql);

  accountId = randomUUID();
  folderId = randomUUID();
  messageId = randomUUID();

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'notify-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject, sync_version)
    VALUES (${messageId}, ${accountId}, ${folderId}, '100', 'Notify Test', '0')
  `;
});

describe("PG LISTEN/NOTIFY: sync_queue triggers", () => {
  test("NOTIFY fires on sync_queue INSERT with correct channel", async () => {
    const channel = `sync_queue_${accountId}`;

    // Set up listener and wait until LISTEN is confirmed active
    let onNotify!: (payload: string) => void;
    const notifyPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`NOTIFY on "${channel}" timed out after 10000ms`));
      }, 10_000);
      onNotify = (payload: string) => {
        clearTimeout(timer);
        resolve(payload);
      };
    });

    const subscription = await listenerSql.listen(channel, onNotify);

    try {
      // Trigger flag change -> sync_queue INSERT -> NOTIFY
      await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;

      const payload = await notifyPromise;
      expect(payload).toBeTruthy();

      // The trigger sends JSON with id and action
      const parsed = JSON.parse(payload);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("action");
      expect(parsed.action).toBe("flag_add");
    } finally {
      await subscription.unlisten();
    }
  });
});
