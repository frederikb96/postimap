import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Database } from "../../../src/db/schema.js";
import { withSyncWriter } from "../../../src/db/writer.js";
import { getDatabaseUrl } from "../../setup/env.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

interface DavEvent {
  v: number;
  type: string;
  op: string;
  id: string;
  account_id?: string;
  collection_id?: string;
  old_collection_id?: string | null;
  origin?: string;
  changed?: string[];
  backfill?: boolean;
  action?: string;
}

let pgSql: postgres.Sql;
let listenerSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
let accountId: string;
let calendarId: string;
let otherCalendarId: string;

let events: DavEvent[];
let subscription: { unlisten: () => Promise<void> } | undefined;

const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  listenerSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
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
  calendarId = randomUUID();
  otherCalendarId = randomUUID();
  await pgSql`
    INSERT INTO dav_accounts (id, name, url, username, password, is_active, state)
    VALUES (${accountId}, 'dav-events', 'https://dav.example.org/', 'u', ${Buffer.from([0x00])}, true, 'active')
  `;
  await withSyncWriter(db, (trx) =>
    trx
      .insertInto("dav_collections")
      .values([
        {
          id: calendarId,
          account_id: accountId,
          kind: "calendar",
          href: "https://dav.example.org/u/cal/",
          slug: "cal",
        },
        {
          id: otherCalendarId,
          account_id: accountId,
          kind: "calendar",
          href: "https://dav.example.org/u/other/",
          slug: "other",
        },
      ])
      .execute(),
  );

  events = [];
  subscription = await listenerSql.listen("postimap_events", (payload) => {
    events.push(JSON.parse(payload) as DavEvent);
  });
});

afterEach(async () => {
  await subscription?.unlisten();
});

// postimap_events is one channel for the whole test database; filter to this test's account.
function eventsOfType(type: string): DavEvent[] {
  return events.filter((e) => e.type === type && e.account_id === accountId);
}

async function mirroredObject(collectionId: string, href: string): Promise<string> {
  const id = randomUUID();
  await withSyncWriter(db, (trx) =>
    trx
      .insertInto("dav_objects")
      .values({
        id,
        account_id: accountId,
        collection_id: collectionId,
        href,
        etag: '"e1"',
        kind: "calendar",
        data: ICS,
        uid: href,
      })
      .execute(),
  );
  return id;
}

describe("postimap_events: dav_object", () => {
  test("a consumer INSERT fires insert with origin=app and the collection", async () => {
    const [row] = await pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${accountId}, ${calendarId}, ${ICS}) RETURNING id
    `;
    await waitFor(() => eventsOfType("dav_object").length > 0);
    expect(eventsOfType("dav_object")[0]).toMatchObject({
      v: 1,
      op: "insert",
      id: row.id,
      collection_id: calendarId,
      origin: "app",
    });
  });

  test("a sync-engine INSERT reports origin=sync; one under postimap.backfill fires nothing", async () => {
    await mirroredObject(calendarId, "https://dav.example.org/u/cal/live.ics");
    await waitFor(() => eventsOfType("dav_object").length > 0);
    expect(eventsOfType("dav_object")[0].origin).toBe("sync");

    events = [];
    await withSyncWriter(
      db,
      (trx) =>
        trx
          .insertInto("dav_objects")
          .values({
            account_id: accountId,
            collection_id: calendarId,
            href: "https://dav.example.org/u/cal/backfilled.ics",
            kind: "calendar",
            data: ICS,
          })
          .execute(),
      { backfill: true },
    );
    // Something unrelated on the same channel, so the absence above is proven rather than
    // a listener that never delivered.
    await pgSql`UPDATE dav_accounts SET name = 'renamed' WHERE id = ${accountId}`;
    await waitFor(() => eventsOfType("dav_account").length > 0);
    expect(eventsOfType("dav_object")).toHaveLength(0);
  });

  test("a move reports changed=[collection_id, etag] and carries old_collection_id", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/m.ics");
    await waitFor(() => eventsOfType("dav_object").length > 0);
    events = [];

    await pgSql`UPDATE dav_objects SET collection_id = ${otherCalendarId} WHERE id = ${objectId}`;
    await waitFor(() => eventsOfType("dav_object").length > 0);
    const event = eventsOfType("dav_object")[0];
    expect(event.op).toBe("update");
    expect(event.collection_id).toBe(otherCalendarId);
    expect(event.old_collection_id).toBe(calendarId);
    expect(event.changed).toEqual(expect.arrayContaining(["collection_id", "etag"]));
  });

  test("an update that is not a move carries old_collection_id as null", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/e.ics");
    await waitFor(() => eventsOfType("dav_object").length > 0);
    events = [];

    await pgSql`UPDATE dav_objects SET data = 'BEGIN:VCALENDAR\r\nX:1\r\nEND:VCALENDAR\r\n' WHERE id = ${objectId}`;
    await waitFor(() => eventsOfType("dav_object").length > 0);
    const event = eventsOfType("dav_object")[0];
    expect(event.changed).toEqual(["data"]);
    expect(event.old_collection_id).toBeNull();
  });

  test("writing only bookkeeping columns fires no event", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/b.ics");
    await waitFor(() => eventsOfType("dav_object").length > 0);
    events = [];

    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_objects")
        .set({ last_modified: new Date(), size_bytes: 12 })
        .where("id", "=", objectId)
        .execute(),
    );
    await pgSql`UPDATE dav_accounts SET name = 'renamed' WHERE id = ${accountId}`;
    await waitFor(() => eventsOfType("dav_account").length > 0);
    expect(eventsOfType("dav_object")).toHaveLength(0);
  });
});

describe("postimap_events: dav_collection", () => {
  test("initial_sync_done flipping true fires a single sync_complete, not a generic update", async () => {
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ initial_sync_done: true, sync_error: null })
        .where("id", "=", calendarId)
        .execute(),
    );
    await waitFor(() => eventsOfType("dav_collection").length > 0);
    const own = eventsOfType("dav_collection");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      op: "sync_complete",
      collection_id: calendarId,
      backfill: true,
    });
  });

  test("backfill_total being written arrives as an update naming it", async () => {
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ backfill_total: 40 })
        .where("id", "=", calendarId)
        .execute(),
    );
    await waitFor(() => eventsOfType("dav_collection").length > 0);
    expect(eventsOfType("dav_collection")[0]).toMatchObject({
      op: "update",
      changed: ["backfill_total"],
      origin: "sync",
    });
  });

  test("sync_token and ctag moving every cycle fire nothing", async () => {
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ sync_token: "t2", ctag: "c2", last_synced_at: new Date() })
        .where("id", "=", calendarId)
        .execute(),
    );
    await pgSql`UPDATE dav_accounts SET name = 'renamed' WHERE id = ${accountId}`;
    await waitFor(() => eventsOfType("dav_account").length > 0);
    expect(eventsOfType("dav_collection")).toHaveLength(0);
  });
});

describe("postimap_events: dav_notification", () => {
  test("an inserted notification fires an event naming the row, the action and the collection", async () => {
    const [row] = await pgSql<{ id: string }[]>`
      INSERT INTO dav_notifications (account_id, action, collection_id, error)
      VALUES (${accountId}, 'mkcol', ${calendarId}, 'refused') RETURNING id
    `;
    await waitFor(() => eventsOfType("dav_notification").length > 0);
    const event = eventsOfType("dav_notification")[0];
    // The identity column arrives as a JSON number, the same shape as `notification`.
    expect(Number(event.id)).toBe(Number(row.id));
    expect(event).toMatchObject({ op: "insert", collection_id: calendarId, action: "mkcol" });
  });
});
