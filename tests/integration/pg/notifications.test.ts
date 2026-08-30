import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { purgeExpired, type RetentionConfig } from "../../../src/sync/retention.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
  insertMirroredFolder,
  truncateAll,
} from "../../setup/pg-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

interface PostimapEvent {
  type: string;
  op: string;
  id: string;
  action?: string;
  account_id?: string;
  origin?: string;
}

let pgSql: postgres.Sql;
let listenerSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
let accountId: string;
let folderId: string;
let messageId: string;
let events: PostimapEvent[];
let subscription: { unlisten: () => Promise<void> } | undefined;

const config: RetentionConfig = {
  purgeExpungedAfterDays: 30,
  purgeFoldersAfterDays: 7,
  auditDays: 90,
  notificationsDays: 90,
};

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  listenerSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
  await pgSql`GRANT postimap_app TO CURRENT_USER`;
});

afterAll(async () => {
  if (db) await db.destroy();
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
    VALUES (${accountId}, ${`notify-${randomUUID()}`}, '127.0.0.1', 993, 'test@test.local',
      ${Buffer.from([0x00, ...Buffer.from("pass")])}, true, 'active')
  `;
  await insertMirroredFolder(
    pgSql,
    (tx) => tx`
    INSERT INTO folders (id, account_id, imap_name, display_name)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox')
  `,
  );
  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
    VALUES (${messageId}, ${accountId}, ${folderId}, '1', 'Notify test')
  `;

  events = [];
  subscription = await listenerSql.listen("postimap_events", (payload) => {
    events.push(JSON.parse(payload) as PostimapEvent);
  });
});

afterEach(async () => {
  await subscription?.unlisten();
});

/** Runs `fn` as postimap_app; always rolls back so attempts never persist. */
async function asAppRole<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let captured: T;
  await pgSql
    .begin(async (tx) => {
      await tx`SET LOCAL ROLE postimap_app`;
      captured = await fn(tx);
      throw new Error("rollback-after-probe");
    })
    .catch((err) => {
      if (!(err instanceof Error) || err.message !== "rollback-after-probe") throw err;
    });
  // biome-ignore lint/style/noNonNullAssertion: always assigned before the sentinel throw
  return captured!;
}

async function insertNotification(
  overrides: { acknowledged_at?: Date | null; created_at?: Date; action?: string } = {},
): Promise<string> {
  const rows = await pgSql<{ id: string }[]>`
    INSERT INTO sync_notifications (account_id, action, message_id, folder_id, error, detail,
                                    acknowledged_at, created_at)
    VALUES (${accountId}, ${overrides.action ?? "flag_add"}, ${messageId}, ${folderId},
            'server said no', ${pgSql.json({ attempted: { flag: "\\Seen" } })},
            ${overrides.acknowledged_at ?? null}, ${overrides.created_at ?? new Date()})
    RETURNING id::text AS id
  `;
  return rows[0].id;
}

describe("sync_notifications: the write contract", () => {
  test("the app role can acknowledge and can change nothing else", async () => {
    const id = await insertNotification();

    await asAppRole(async (tx) => {
      await expect(tx`SELECT * FROM sync_notifications`).resolves.toBeDefined();
      await expect(
        tx`UPDATE sync_notifications SET acknowledged_at = now() WHERE id = ${id}::bigint`,
      ).resolves.toBeDefined();
    });

    // Each refusal aborts its transaction, so they cannot share one -- the second would
    // report the first's abort instead of its own permission error.
    for (const probe of [
      (tx: postgres.TransactionSql) =>
        tx`UPDATE sync_notifications SET error = 'rewritten' WHERE id = ${id}::bigint`,
      (tx: postgres.TransactionSql) =>
        tx`UPDATE sync_notifications SET reverted_at = now() WHERE id = ${id}::bigint`,
      (tx: postgres.TransactionSql) =>
        tx`INSERT INTO sync_notifications (account_id, action) VALUES (${accountId}, 'invented')`,
      (tx: postgres.TransactionSql) => tx`DELETE FROM sync_notifications WHERE id = ${id}::bigint`,
    ]) {
      await asAppRole(async (tx) => {
        await expect(probe(tx)).rejects.toThrow(/permission denied/i);
      });
    }
  });

  test("acknowledging many at once is one statement", async () => {
    await insertNotification();
    await insertNotification();

    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL ROLE postimap_app`;
      await tx`
        UPDATE sync_notifications SET acknowledged_at = now()
        WHERE account_id = ${accountId} AND acknowledged_at IS NULL
      `;
    });

    const left = await pgSql`
      SELECT id FROM sync_notifications
      WHERE account_id = ${accountId} AND acknowledged_at IS NULL
    `;
    expect(left).toHaveLength(0);
  });

  test("an insert announces itself on postimap_events", async () => {
    const id = await insertNotification({ action: "move" });

    await waitFor(() => events.some((e) => e.type === "notification"));
    const event = events.find((e) => e.type === "notification");
    expect(event).toMatchObject({
      type: "notification",
      op: "insert",
      action: "move",
      account_id: accountId,
    });
    expect(String(event?.id)).toBe(id);
  });
});

describe("sync_notifications: retention", () => {
  test("an acknowledged notification past the window is purged", async () => {
    const id = await insertNotification({
      acknowledged_at: daysAgo(91),
      created_at: daysAgo(120),
    });

    const result = await purgeExpired(db, config);
    expect(result.notificationsDeleted).toBe(1);

    const left = await pgSql`SELECT id FROM sync_notifications WHERE id = ${id}::bigint`;
    expect(left).toHaveLength(0);
  });

  test("an unacknowledged notification is never purged, however old", async () => {
    // Age alone must not be able to destroy the only record a consumer has that one of
    // its writes never reached the server.
    const id = await insertNotification({ created_at: daysAgo(3650) });

    const result = await purgeExpired(db, config);
    expect(result.notificationsDeleted).toBe(0);

    const left = await pgSql`SELECT id FROM sync_notifications WHERE id = ${id}::bigint`;
    expect(left).toHaveLength(1);
  });

  test("a recently acknowledged notification survives", async () => {
    await insertNotification({ acknowledged_at: daysAgo(1), created_at: daysAgo(200) });

    const result = await purgeExpired(db, config);
    expect(result.notificationsDeleted).toBe(0);
  });
});
