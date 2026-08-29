import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectPg,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

interface PostimapEvent {
  v: number;
  type: "message" | "folder" | "account" | "outbox";
  op: string;
  id: string;
  account_id?: string;
  folder_id?: string;
  origin?: "sync" | "app";
  changed?: string[];
  backfill?: boolean;
}

let pgSql: postgres.Sql;
let listenerSql: postgres.Sql;
let schema: string;
let accountId: string;
let folderId: string;

let events: PostimapEvent[];
let subscription: { unlisten: () => Promise<void> } | undefined;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
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

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'events-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  events = [];
  subscription = await listenerSql.listen("postimap_events", (payload) => {
    events.push(JSON.parse(payload) as PostimapEvent);
  });
});

afterEach(async () => {
  await subscription?.unlisten();
});

// postimap_events is one global channel shared by every schema in this test database, so
// other pg-integration files running concurrently also produce traffic on it. Filtering
// by this test's own account_id (a fresh random UUID per test) is what makes collection
// exclusive to this test, the same way a real multi-account consumer would filter.
function eventsOfType(type: PostimapEvent["type"]): PostimapEvent[] {
  return events.filter((e) => e.type === type && e.account_id === accountId);
}

describe("postimap_events: messages", () => {
  test("INSERT fires a message event with origin=app", async () => {
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
      VALUES (${messageId}, ${accountId}, ${folderId}, '1', 'Hello')
    `;

    await waitFor(() => eventsOfType("message").length > 0);
    const event = eventsOfType("message")[0];
    expect(event.v).toBe(1);
    expect(event.op).toBe("insert");
    expect(event.id).toBe(messageId);
    expect(event.account_id).toBe(accountId);
    expect(event.folder_id).toBe(folderId);
    expect(event.origin).toBe("app");
  });

  test("UPDATE of a watched column reports it in changed[]", async () => {
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid) VALUES
        (${messageId}, ${accountId}, ${folderId}, '1')
    `;
    await waitFor(() => eventsOfType("message").length > 0);
    events = [];

    await pgSql`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;

    await waitFor(() => eventsOfType("message").length > 0);
    const event = eventsOfType("message")[0];
    expect(event.op).toBe("update");
    expect(event.changed).toEqual(["is_seen"]);
  });

  test("UPDATE inside a sync-writer transaction reports origin=sync", async () => {
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid) VALUES
        (${messageId}, ${accountId}, ${folderId}, '1')
    `;
    await waitFor(() => eventsOfType("message").length > 0);
    events = [];

    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL postimap.writer = 'sync'`;
      await tx`UPDATE messages SET is_seen = true WHERE id = ${messageId}`;
    });

    await waitFor(() => eventsOfType("message").length > 0);
    expect(eventsOfType("message")[0].origin).toBe("sync");
  });

  test("UPDATE of only an unwatched column fires no event", async () => {
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid) VALUES
        (${messageId}, ${accountId}, ${folderId}, '1')
    `;
    await waitFor(() => eventsOfType("message").length > 0);
    events = [];

    await pgSql`UPDATE messages SET body_text = 'new body' WHERE id = ${messageId}`;

    // Give NOTIFY a moment to arrive if it were going to.
    await new Promise((r) => setTimeout(r, 300));
    expect(eventsOfType("message")).toHaveLength(0);
  });

  test("DELETE fires an event with op=delete", async () => {
    const messageId = randomUUID();
    await pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid) VALUES
        (${messageId}, ${accountId}, ${folderId}, '1')
    `;
    await waitFor(() => eventsOfType("message").length > 0);
    events = [];

    await pgSql`DELETE FROM messages WHERE id = ${messageId}`;

    await waitFor(() => eventsOfType("message").length > 0);
    expect(eventsOfType("message")[0].op).toBe("delete");
  });

  test("backfill suppression: INSERT under postimap.backfill='on' fires no message event", async () => {
    const messageId = randomUUID();
    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL postimap.writer = 'sync'`;
      await tx`SET LOCAL postimap.backfill = 'on'`;
      await tx`
        INSERT INTO messages (id, account_id, folder_id, imap_uid)
        VALUES (${messageId}, ${accountId}, ${folderId}, '1')
      `;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(eventsOfType("message")).toHaveLength(0);
  });
});

describe("postimap_events: folders", () => {
  test("initial_sync_done flipping true fires a single sync_complete event, not a generic update", async () => {
    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL postimap.writer = 'sync'`;
      await tx`UPDATE folders SET initial_sync_done = true WHERE id = ${folderId}`;
    });

    await waitFor(() => eventsOfType("folder").length > 0);
    const folderEvents = eventsOfType("folder");
    expect(folderEvents).toHaveLength(1);
    expect(folderEvents[0].op).toBe("sync_complete");
    expect(folderEvents[0].backfill).toBe(true);
    expect(folderEvents[0].origin).toBe("sync");
  });

  test("special_use change fires a generic update event", async () => {
    await pgSql`UPDATE folders SET special_use = 'archive' WHERE id = ${folderId}`;

    await waitFor(() => eventsOfType("folder").length > 0);
    const event = eventsOfType("folder")[0];
    expect(event.op).toBe("update");
    expect(event.changed).toEqual(["special_use"]);
  });

  test("high-frequency bookkeeping columns (uidvalidity, total_count) do not fire events", async () => {
    await pgSql`UPDATE folders SET uidvalidity = '123', uidnext = '456' WHERE id = ${folderId}`;
    await new Promise((r) => setTimeout(r, 300));
    expect(eventsOfType("folder")).toHaveLength(0);
  });

  test("soft-delete (deleted_at set) fires an update event", async () => {
    await pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;
    await waitFor(() => eventsOfType("folder").length > 0);
    expect(eventsOfType("folder")[0].changed).toEqual(["deleted_at"]);
  });
});

describe("postimap_events: accounts", () => {
  test("INSERT fires an account event", async () => {
    const newAccountId = randomUUID();
    await pgSql`
      INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password)
      VALUES (${newAccountId}, 'second-account', '127.0.0.1', 993, 'x@test.local', ${Buffer.from("p")})
    `;

    // A new account_id, so the standard eventsOfType (scoped to the fixture accountId)
    // doesn't apply here -- filter by the freshly inserted id directly.
    const forNewAccount = () => events.filter((e) => e.type === "account" && e.id === newAccountId);
    await waitFor(() => forNewAccount().length > 0);
    const event = forNewAccount()[0];
    expect(event.op).toBe("insert");
    expect(event.origin).toBe("app");
  });

  test("UPDATE is_active reports it in changed[]", async () => {
    await pgSql`UPDATE accounts SET is_active = false WHERE id = ${accountId}`;
    await waitFor(() => eventsOfType("account").length > 0);
    expect(eventsOfType("account")[0].changed).toEqual(["is_active"]);
  });

  test("state transition made as the sync engine reports origin=sync", async () => {
    // Fixture accounts are inserted with state='active' already, so transition to a
    // genuinely different value or IS DISTINCT FROM sees no change and nothing fires.
    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL postimap.writer = 'sync'`;
      await tx`UPDATE accounts SET state = 'syncing' WHERE id = ${accountId}`;
    });
    await waitFor(() => eventsOfType("account").length > 0);
    expect(eventsOfType("account")[0].origin).toBe("sync");
  });
});

describe("postimap_events: outbox", () => {
  test("INSERT fires an outbox event", async () => {
    const outboxId = randomUUID();
    await pgSql`
      INSERT INTO outbox (id, account_id, kind, to_addrs, subject)
      VALUES (${outboxId}, ${accountId}, 'send', '["to@test.local"]', 'Hi')
    `;

    await waitFor(() => eventsOfType("outbox").length > 0);
    const event = eventsOfType("outbox")[0];
    expect(event.op).toBe("insert");
    expect(event.id).toBe(outboxId);
    expect(event.account_id).toBe(accountId);
  });

  test("UPDATE status reports changed=['status']", async () => {
    const outboxId = randomUUID();
    await pgSql`
      INSERT INTO outbox (id, account_id, kind) VALUES (${outboxId}, ${accountId}, 'draft')
    `;
    await waitFor(() => eventsOfType("outbox").length > 0);
    events = [];

    await pgSql`UPDATE outbox SET status = 'sent' WHERE id = ${outboxId}`;
    await waitFor(() => eventsOfType("outbox").length > 0);
    expect(eventsOfType("outbox")[0].changed).toEqual(["status"]);
  });
});
