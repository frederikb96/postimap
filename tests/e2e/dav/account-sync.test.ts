import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DavClient } from "../../../src/dav/client.js";
import {
  type CollectionRow,
  fullReconcile,
  syncCollectionIncremental,
} from "../../../src/dav/collection-sync.js";
import {
  discoverCollections,
  discoverHomes,
  reconcileCollections,
} from "../../../src/dav/discovery.js";
import { DavOutboundProcessor } from "../../../src/dav/outbound.js";
import { withSyncWriter } from "../../../src/db/writer.js";
import {
  type DavE2EContext,
  setupDavE2EContext,
  teardownDavE2EContext,
} from "../../setup/dav-e2e-helpers.js";
import { sampleEvent } from "../../setup/dav-helpers.js";
import { env, getRadicaleUrl } from "../../setup/env.js";

let ctx: DavE2EContext;
let client: DavClient;

beforeAll(async () => {
  ctx = await setupDavE2EContext("e2e-dav-account");
  client = new DavClient({
    baseUrl: getRadicaleUrl(),
    username: ctx.davUsername,
    password: env.DAV_PASSWORD,
    tlsRejectUnauthorized: true,
    requestTimeoutMs: 10_000,
  });
});

afterAll(async () => {
  await teardownDavE2EContext(ctx);
});

function makeOutbound(): DavOutboundProcessor {
  return new DavOutboundProcessor(ctx.db, ctx.databaseUrl, () => client, 60_000);
}

/**
 * The reconcile step of a sync cycle, driven directly. DavAccountSync persists the
 * discovered homes onto the account row (mkcol needs them to build a target URL), so
 * this does the same write.
 */
async function discoverAndReconcile(): Promise<{
  calendarHomeUrl: string;
  addressbookHomeUrl: string;
}> {
  const homes = await discoverHomes(client);
  if (!homes.calendarHomeUrl || !homes.addressbookHomeUrl) {
    throw new Error("Expected both homes to be discoverable on a fresh Radicale principal");
  }
  await withSyncWriter(ctx.db, (trx) =>
    trx
      .updateTable("dav_accounts")
      .set({
        principal_url: homes.principalUrl,
        calendar_home_url: homes.calendarHomeUrl,
        addressbook_home_url: homes.addressbookHomeUrl,
      })
      .where("id", "=", ctx.davAccountId)
      .execute(),
  );
  const discovered = [
    ...(await discoverCollections(client, homes.calendarHomeUrl, "calendar")),
    ...(await discoverCollections(client, homes.addressbookHomeUrl, "addressbook")),
  ];
  await reconcileCollections(ctx.db, ctx.davAccountId, discovered);
  return { calendarHomeUrl: homes.calendarHomeUrl, addressbookHomeUrl: homes.addressbookHomeUrl };
}

/** A consumer-created calendar, drained so it exists on the server, discovered so it has a tier. */
async function createCalendar(slug: string): Promise<{ id: string; href: string }> {
  const [row] = await ctx.pgSql<{ id: string }[]>`
    INSERT INTO dav_collections (account_id, kind, slug, display_name)
    VALUES (${ctx.davAccountId}, 'calendar', ${slug}, ${slug})
    RETURNING id
  `;
  await makeOutbound().drain(ctx.davAccountId);
  await discoverAndReconcile();
  const updated = await ctx.db
    .selectFrom("dav_collections")
    .select(["id", "href"])
    .where("id", "=", row.id)
    .executeTakeFirstOrThrow();
  if (!updated.href) throw new Error(`mkcol for ${slug} did not produce an href`);
  return { id: updated.id, href: updated.href };
}

async function collectionRow(id: string): Promise<CollectionRow> {
  const row = await ctx.db
    .selectFrom("dav_collections")
    .select(["id", "account_id", "href", "kind", "sync_tier"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row;
}

async function queueStatuses(): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom("dav_sync_queue")
    .select("status")
    .where("account_id", "=", ctx.davAccountId)
    .execute();
  return rows.map((r) => r.status);
}

describe("E2E: DAV account sync -- discovery and outbound", () => {
  test("a fresh account discovers empty calendar and address-book homes", async () => {
    const homes = await discoverAndReconcile();
    expect(homes.calendarHomeUrl).toContain(ctx.davUsername);
    expect(homes.addressbookHomeUrl).toContain(ctx.davUsername);
  });

  test("creating a dav_collections row enqueues mkcol, and the calendar appears on the server", async () => {
    const [row] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_collections (account_id, kind, slug, display_name)
      VALUES (${ctx.davAccountId}, 'calendar', 'work', 'Work Calendar')
      RETURNING id
    `;
    const collectionId = row.id;

    await makeOutbound().drain(ctx.davAccountId);

    const updated = await ctx.db
      .selectFrom("dav_collections")
      .select(["href", "sync_tier"])
      .where("id", "=", collectionId)
      .executeTakeFirstOrThrow();
    expect(updated.href).toBeTruthy();
    expect(updated.href).toContain("work");

    // Confirm it is really on the server, not just recorded locally.
    const homes = await discoverHomes(client);
    const discovered = await discoverCollections(
      client,
      homes.calendarHomeUrl as string,
      "calendar",
    );
    expect(discovered.some((c) => c.href === updated.href)).toBe(true);
  });

  test("creating a dav_objects row enqueues put, and the event lands on the server", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href"])
      .where("account_id", "=", ctx.davAccountId)
      .where("kind", "=", "calendar")
      .executeTakeFirstOrThrow();

    const uid = `e2e-evt-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${collection.id}, ${sampleEvent(uid, "First Version")})
      RETURNING id
    `;

    await makeOutbound().drain(ctx.davAccountId);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["href", "etag", "uid", "summary"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(row.href).toBeTruthy();
    expect(row.etag).toBeTruthy();
    expect(row.uid).toBe(uid);
    expect(row.summary).toBe("First Version");

    const etags = await client.listEtags(collection.href as string);
    expect(etags.has(row.href as string)).toBe(true);
  });

  test("editing a dav_objects row enqueues an update put, and the server's etag changes", async () => {
    const obj = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "href", "etag", "uid", "collection_id"])
      .where("account_id", "=", ctx.davAccountId)
      .executeTakeFirstOrThrow();
    const originalEtag = obj.etag;

    await ctx.pgSql`
      UPDATE dav_objects SET data = ${sampleEvent(obj.uid as string, "Second Version")} WHERE id = ${obj.id}
    `;
    await makeOutbound().drain(ctx.davAccountId);

    const updated = await ctx.db
      .selectFrom("dav_objects")
      .select(["etag", "summary"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(updated.summary).toBe("Second Version");
    expect(updated.etag).not.toBe(originalEtag);
  });

  test("moving a dav_objects row to another collection enqueues move, nulls the etag until it lands, and the server reflects it", async () => {
    const newCollection = await createCalendar("personal");

    const obj = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "href", "collection_id"])
      .where("account_id", "=", ctx.davAccountId)
      .where("collection_id", "!=", newCollection.id)
      .executeTakeFirstOrThrow();
    const oldHref = obj.href as string;
    const oldCollectionId = obj.collection_id;

    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${newCollection.id} WHERE id = ${obj.id}`;
    const pending = await ctx.db
      .selectFrom("dav_objects")
      .select("etag")
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(pending.etag).toBeNull();

    await makeOutbound().drain(ctx.davAccountId);

    const moved = await ctx.db
      .selectFrom("dav_objects")
      .select(["href", "collection_id", "etag"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(moved.collection_id).toBe(newCollection.id);
    expect(moved.href).not.toBe(oldHref);
    expect(moved.etag).toBeTruthy();

    const newEtags = await client.listEtags(newCollection.href);
    expect(newEtags.has(moved.href as string)).toBe(true);

    const oldCollectionRow = await ctx.db
      .selectFrom("dav_collections")
      .select("href")
      .where("id", "=", oldCollectionId)
      .executeTakeFirstOrThrow();
    const oldEtags = await client.listEtags(oldCollectionRow.href as string);
    expect(oldEtags.has(oldHref)).toBe(false);
  });

  test("deleting a dav_objects row enqueues delete, and it is gone from the server", async () => {
    const obj = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "href", "collection_id"])
      .where("account_id", "=", ctx.davAccountId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select("href")
      .where("id", "=", obj.collection_id)
      .executeTakeFirstOrThrow();

    await ctx.pgSql`UPDATE dav_objects SET deleted_at = now() WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const etags = await client.listEtags(collection.href as string);
    expect(etags.has(obj.href as string)).toBe(false);
  });

  test("a PUT with a stale etag is refused with 412, reverted to the server's copy, and notified", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href"])
      .where("account_id", "=", ctx.davAccountId)
      .where("kind", "=", "calendar")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    const uid = `e2e-conflict-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${collection.id}, ${sampleEvent(uid, "Local Version")})
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);
    const created = await ctx.db
      .selectFrom("dav_objects")
      .select(["href"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();

    // Someone else changes the object on the server directly, without going through PG.
    await client.put(
      created.href as string,
      sampleEvent(uid, "Server Version"),
      "text/calendar; charset=utf-8",
      {},
    );

    // The consumer edits the row it still holds, unaware the server has moved on.
    await ctx.pgSql`UPDATE dav_objects SET data = ${sampleEvent(uid, "Conflicting Local Edit")} WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const after = await ctx.db
      .selectFrom("dav_objects")
      .select(["data", "summary"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(after.summary).toBe("Server Version");
    expect(after.data).toContain("Server Version");

    const notification = await ctx.db
      .selectFrom("dav_notifications")
      .select(["error", "reverted_at"])
      .where("object_id", "=", obj.id)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    expect(notification).toBeDefined();
    expect(notification?.reverted_at).not.toBeNull();
  });

  test("a DELETE against an object the server changed first is refused, un-tombstoned with the server's copy, and notified", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href"])
      .where("account_id", "=", ctx.davAccountId)
      .where("kind", "=", "calendar")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    const uid = `e2e-del-conflict-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${collection.id}, ${sampleEvent(uid, "Before")})
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);
    const created = await ctx.db
      .selectFrom("dav_objects")
      .select(["href"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();

    await client.put(
      created.href as string,
      sampleEvent(uid, "Edited On Server"),
      "text/calendar; charset=utf-8",
      {},
    );
    await ctx.pgSql`UPDATE dav_objects SET deleted_at = now() WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const after = await ctx.db
      .selectFrom("dav_objects")
      .select(["deleted_at", "summary"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(after.deleted_at).toBeNull();
    expect(after.summary).toBe("Edited On Server");
    expect(await client.getEtag(created.href as string)).not.toBeNull();

    const notification = await ctx.db
      .selectFrom("dav_notifications")
      .select(["action", "reverted_at"])
      .where("object_id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(notification.action).toBe("delete");
    expect(notification.reverted_at).not.toBeNull();
  });

  test("updating display_name, color and description enqueues proppatch, and the server reports the new values", async () => {
    const collection = await createCalendar("props");

    await ctx.pgSql`
      UPDATE dav_collections
      SET display_name = 'Renamed', color = '#112233FF', description = 'A description'
      WHERE id = ${collection.id}
    `;
    await makeOutbound().drain(ctx.davAccountId);

    const homes = await discoverHomes(client);
    const discovered = await discoverCollections(
      client,
      homes.calendarHomeUrl as string,
      "calendar",
    );
    const onServer = discovered.find((c) => c.href === collection.href);
    expect(onServer?.displayName).toBe("Renamed");
    expect(onServer?.color).toBe("#112233FF");
    expect(onServer?.description).toBe("A description");
  });

  test("reconciliation keeps a consumer's rename until its proppatch has landed", async () => {
    const collection = await createCalendar("rename-race");

    await ctx.pgSql`UPDATE dav_collections SET display_name = 'Consumer Name' WHERE id = ${collection.id}`;
    // A cycle runs before the queue drains; the server still says 'rename-race'.
    await discoverAndReconcile();
    const mid = await ctx.db
      .selectFrom("dav_collections")
      .select("display_name")
      .where("id", "=", collection.id)
      .executeTakeFirstOrThrow();
    expect(mid.display_name).toBe("Consumer Name");

    await makeOutbound().drain(ctx.davAccountId);
    await discoverAndReconcile();
    const after = await ctx.db
      .selectFrom("dav_collections")
      .select("display_name")
      .where("id", "=", collection.id)
      .executeTakeFirstOrThrow();
    expect(after.display_name).toBe("Consumer Name");
  });

  test("deleting a dav_collections row enqueues rmcol, tombstones its objects, and removes it from the server", async () => {
    const collection = await createCalendar("to-delete");

    const uid = `e2e-rmcol-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${collection.id}, ${sampleEvent(uid)})
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);

    await ctx.pgSql`UPDATE dav_collections SET deleted_at = now() WHERE id = ${collection.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const objRow = await ctx.db
      .selectFrom("dav_objects")
      .select("deleted_at")
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(objRow.deleted_at).not.toBeNull();

    const homes = await discoverHomes(client);
    const discovered = await discoverCollections(
      client,
      homes.calendarHomeUrl as string,
      "calendar",
    );
    expect(discovered.some((c) => c.href === collection.href)).toBe(false);
  });
});

describe("E2E: DAV outbound -- more than one operation queued per object", () => {
  test("insert then move before the queue drains lands the object in the destination, with no notification", async () => {
    const source = await createCalendar("multi-src");
    const dest = await createCalendar("multi-dst");

    const uid = `e2e-multi-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${source.id}, ${sampleEvent(uid, "Created then moved")})
      RETURNING id
    `;
    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${dest.id} WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["href", "etag", "collection_id", "deleted_at"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(row.collection_id).toBe(dest.id);
    expect(row.deleted_at).toBeNull();
    expect(row.etag).toBeTruthy();
    expect(row.href).toContain("multi-dst");
    expect((await client.listEtags(dest.href)).has(row.href as string)).toBe(true);
    expect((await client.listEtags(source.href)).size).toBe(0);

    const notifications = await ctx.db
      .selectFrom("dav_notifications")
      .select("id")
      .where("object_id", "=", obj.id)
      .execute();
    expect(notifications).toHaveLength(0);
    expect(await queueStatuses()).not.toContain("dead");
  });

  test("two moves before the queue drains end at the last destination", async () => {
    const a = await createCalendar("chain-a");
    const b = await createCalendar("chain-b");
    const c = await createCalendar("chain-c");

    const uid = `e2e-chain-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${a.id}, ${sampleEvent(uid, "Chained")})
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);

    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${b.id} WHERE id = ${obj.id}`;
    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${c.id} WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["href", "collection_id", "deleted_at"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(row.collection_id).toBe(c.id);
    expect(row.deleted_at).toBeNull();
    expect((await client.listEtags(c.href)).has(row.href as string)).toBe(true);
    expect((await client.listEtags(a.href)).size).toBe(0);
    expect((await client.listEtags(b.href)).size).toBe(0);
    expect(await queueStatuses()).not.toContain("dead");
  });

  test("an edit followed by a move carries the edited body to the destination", async () => {
    const source = await createCalendar("edit-src");
    const dest = await createCalendar("edit-dst");

    const uid = `e2e-edit-move-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${source.id}, ${sampleEvent(uid, "Original")})
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);

    await ctx.pgSql`UPDATE dav_objects SET data = ${sampleEvent(uid, "Edited")} WHERE id = ${obj.id}`;
    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${dest.id} WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["href", "summary"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    const [onServer] = await client.multiget(dest.href, [row.href as string], "calendar");
    expect(onServer?.data).toContain("SUMMARY:Edited");
    expect(row.summary).toBe("Edited");
  });
});

describe("E2E: DAV account sync -- inbound", () => {
  test("an object created directly on the server is picked up by an incremental sync", async () => {
    await discoverAndReconcile();
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href", "sync_tier"])
      .where("account_id", "=", ctx.davAccountId)
      .where("slug", "=", "work")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(collection.sync_tier).toBe("sync");

    const uid = `e2e-inbound-${randomUUID()}`;
    const href = new URL(`${uid}.ics`, collection.href as string).toString();
    const put = await client.put(
      href,
      sampleEvent(uid, "External Event"),
      "text/calendar; charset=utf-8",
      { create: true },
    );
    expect(put.ok).toBe(true);

    const result = await syncCollectionIncremental(
      ctx.db,
      client,
      await collectionRow(collection.id),
      null,
    );
    expect(result.upserted).toBeGreaterThanOrEqual(1);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["uid", "summary", "href"])
      .where("collection_id", "=", collection.id)
      .where("uid", "=", uid)
      .executeTakeFirstOrThrow();
    expect(row.summary).toBe("External Event");
    expect(row.href).toBe(href);
  });

  test("after a sync the stored token equals the one the home listing reports, so an unchanged collection can be skipped", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href", "sync_token"])
      .where("account_id", "=", ctx.davAccountId)
      .where("slug", "=", "work")
      .executeTakeFirstOrThrow();
    expect(collection.sync_token).toBeTruthy();

    const homes = await discoverHomes(client);
    const discovered = await discoverCollections(
      client,
      homes.calendarHomeUrl as string,
      "calendar",
    );
    const listed = discovered.find((c) => c.href === collection.href);
    expect(listed?.syncToken).toBe(collection.sync_token);
  });

  test("an object deleted directly on the server is tombstoned by the next incremental sync", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href", "sync_tier"])
      .where("account_id", "=", ctx.davAccountId)
      .where("slug", "=", "work")
      .executeTakeFirstOrThrow();

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "href"])
      .where("collection_id", "=", collection.id)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    await client.delete(row.href as string);
    await syncCollectionIncremental(ctx.db, client, await collectionRow(collection.id), null);

    const after = await ctx.db
      .selectFrom("dav_objects")
      .select("deleted_at")
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(after.deleted_at).not.toBeNull();
  });

  test("full reconcile finds the same server truth as an incremental sync via etag diff", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href", "sync_tier"])
      .where("account_id", "=", ctx.davAccountId)
      .where("slug", "=", "work")
      .executeTakeFirstOrThrow();

    const uid = `e2e-reconcile-${randomUUID()}`;
    const href = new URL(`${uid}.ics`, collection.href as string).toString();
    await client.put(href, sampleEvent(uid, "Reconciled Event"), "text/calendar; charset=utf-8", {
      create: true,
    });

    const result = await fullReconcile(ctx.db, client, await collectionRow(collection.id), null);
    expect(result.upserted).toBeGreaterThanOrEqual(1);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select("summary")
      .where("collection_id", "=", collection.id)
      .where("uid", "=", uid)
      .executeTakeFirstOrThrow();
    expect(row.summary).toBe("Reconciled Event");
  });

  test("an etag diff leaves a pending move alone: neither re-imported at the source nor tombstoned at the destination", async () => {
    const source = await createCalendar("guard-src");
    const dest = await createCalendar("guard-dst");
    for (const id of [source.id, dest.id]) {
      await withSyncWriter(ctx.db, (trx) =>
        trx
          .updateTable("dav_collections")
          .set({ sync_tier: "full" })
          .where("id", "=", id)
          .execute(),
      );
    }

    const uid = `e2e-guard-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${source.id}, ${sampleEvent(uid, "Guarded")})
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);
    const before = await ctx.db
      .selectFrom("dav_objects")
      .select("href")
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();

    // Queued, not drained: the row says dest, the server says source.
    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${dest.id} WHERE id = ${obj.id}`;
    await fullReconcile(ctx.db, client, await collectionRow(source.id), null);
    await fullReconcile(ctx.db, client, await collectionRow(dest.id), null);

    const rows = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "collection_id", "deleted_at"])
      .where("uid", "=", uid)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(obj.id);
    expect(rows[0].collection_id).toBe(dest.id);
    expect(rows[0].deleted_at).toBeNull();

    await makeOutbound().drain(ctx.davAccountId);
    const after = await ctx.db
      .selectFrom("dav_objects")
      .select("href")
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(after.href).not.toBe(before.href);
    expect((await client.listEtags(dest.href)).has(after.href as string)).toBe(true);
  });
});
