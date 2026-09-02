import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
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

let pgSql: postgres.Sql;
let db: Kysely<Database>;
let schema: string;
let accountId: string;
let calendarId: string;
let otherCalendarId: string;

const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
});

afterAll(async () => {
  if (db) await db.destroy();
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
    VALUES (${accountId}, 'dav-triggers', 'https://dav.example.org/', 'u', ${Buffer.from([0x00])}, true, 'active')
  `;
  // Mirrored collections, written the way discovery writes them.
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
});

interface QueueRow {
  action: string;
  object_id: string | null;
  collection_id: string | null;
  payload: Record<string, unknown>;
}

async function queue(): Promise<QueueRow[]> {
  return pgSql<QueueRow[]>`
    SELECT action, object_id, collection_id, payload FROM dav_sync_queue
    WHERE account_id = ${accountId} ORDER BY id
  `;
}

/** A mirrored object, as the sync engine would have written it: on the server already. */
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

describe("dav_objects triggers -> dav_sync_queue", () => {
  test("a consumer INSERT enqueues put, and kind is derived from the collection rather than the insert", async () => {
    const [row] = await pgSql<{ id: string; kind: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${accountId}, ${calendarId}, ${ICS}) RETURNING id, kind
    `;
    expect(row.kind).toBe("calendar");
    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "put",
      object_id: row.id,
      collection_id: calendarId,
    });
  });

  test("editing data enqueues put with the row's current href and etag for If-Match", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/a.ics");
    await pgSql`UPDATE dav_objects SET data = 'BEGIN:VCALENDAR\r\nX:1\r\nEND:VCALENDAR\r\n' WHERE id = ${objectId}`;
    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("put");
    expect(entries[0].payload).toMatchObject({
      href: "https://dav.example.org/u/cal/a.ics",
      etag: '"e1"',
    });
  });

  test("a move enqueues move carrying the source collection/href/etag, and nulls the etag on the row", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/m.ics");
    await pgSql`UPDATE dav_objects SET collection_id = ${otherCalendarId} WHERE id = ${objectId}`;

    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "move", collection_id: otherCalendarId });
    expect(entries[0].payload).toMatchObject({
      from_collection_id: calendarId,
      old_href: "https://dav.example.org/u/cal/m.ics",
      old_etag: '"e1"',
    });

    const [row] = await pgSql<{ etag: string | null; href: string }[]>`
      SELECT etag, href FROM dav_objects WHERE id = ${objectId}
    `;
    expect(row.etag).toBeNull();
    expect(row.href).toBe("https://dav.example.org/u/cal/m.ics");
  });

  test("setting deleted_at enqueues delete once; a second write to deleted_at enqueues nothing", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/d.ics");
    await pgSql`UPDATE dav_objects SET deleted_at = now() WHERE id = ${objectId}`;
    await pgSql`UPDATE dav_objects SET deleted_at = now() WHERE id = ${objectId}`;
    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("delete");
    expect(entries[0].payload).toMatchObject({ href: "https://dav.example.org/u/cal/d.ics" });
  });

  test("a write inside a sync-writer transaction enqueues nothing", async () => {
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/s.ics");
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_objects")
        .set({ data: "changed", collection_id: otherCalendarId, deleted_at: new Date() })
        .where("id", "=", objectId)
        .execute(),
    );
    expect(await queue()).toHaveLength(0);
    const [row] = await pgSql<{ etag: string | null }[]>`
      SELECT etag FROM dav_objects WHERE id = ${objectId}
    `;
    expect(row.etag).toBe('"e1"');
  });

  test("total_count follows visible objects across insert, move, tombstone and un-tombstone", async () => {
    const counts = async () => {
      const rows = await pgSql<{ id: string; total_count: number }[]>`
        SELECT id, total_count FROM dav_collections WHERE account_id = ${accountId}
      `;
      return Object.fromEntries(rows.map((r) => [r.id, r.total_count]));
    };
    const objectId = await mirroredObject(calendarId, "https://dav.example.org/u/cal/c.ics");
    expect(await counts()).toEqual({ [calendarId]: 1, [otherCalendarId]: 0 });

    await pgSql`UPDATE dav_objects SET collection_id = ${otherCalendarId} WHERE id = ${objectId}`;
    expect(await counts()).toEqual({ [calendarId]: 0, [otherCalendarId]: 1 });

    await pgSql`UPDATE dav_objects SET deleted_at = now() WHERE id = ${objectId}`;
    expect(await counts()).toEqual({ [calendarId]: 0, [otherCalendarId]: 0 });

    await withSyncWriter(db, (trx) =>
      trx.updateTable("dav_objects").set({ deleted_at: null }).where("id", "=", objectId).execute(),
    );
    expect(await counts()).toEqual({ [calendarId]: 0, [otherCalendarId]: 1 });
  });
});

describe("dav_collections triggers -> dav_sync_queue", () => {
  test("a consumer INSERT enqueues mkcol with the kind, slug and name it will need", async () => {
    const [row] = await pgSql<{ id: string }[]>`
      INSERT INTO dav_collections (account_id, kind, slug, display_name)
      VALUES (${accountId}, 'addressbook', 'friends', 'Friends') RETURNING id
    `;
    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "mkcol", collection_id: row.id });
    expect(entries[0].payload).toMatchObject({
      kind: "addressbook",
      slug: "friends",
      display_name: "Friends",
    });
  });

  test("changing display_name, color or description enqueues proppatch carrying all three", async () => {
    await pgSql`UPDATE dav_collections SET color = '#ff0000' WHERE id = ${calendarId}`;
    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("proppatch");
    expect(entries[0].payload).toEqual({ display_name: null, color: "#ff0000", description: null });
  });

  test("setting deleted_at enqueues rmcol with the href; reconciliation tombstoning does not", async () => {
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ deleted_at: new Date() })
        .where("id", "=", otherCalendarId)
        .execute(),
    );
    expect(await queue()).toHaveLength(0);

    await pgSql`UPDATE dav_collections SET deleted_at = now() WHERE id = ${calendarId}`;
    const entries = await queue();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "rmcol", collection_id: calendarId });
    expect(entries[0].payload).toEqual({ href: "https://dav.example.org/u/cal/" });
  });
});
