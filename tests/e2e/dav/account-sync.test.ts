import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DavClient } from "../../../src/dav/client.js";
import { fullReconcile, syncCollectionIncremental } from "../../../src/dav/collection-sync.js";
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

async function discoverAndReconcile(): Promise<{
  calendarHomeUrl: string;
  addressbookHomeUrl: string;
}> {
  const homes = await discoverHomes(client);
  if (!homes.calendarHomeUrl || !homes.addressbookHomeUrl) {
    throw new Error("Expected both homes to be discoverable on a fresh Radicale principal");
  }
  // The DavAccountSync path persists discovered homes onto the account row (mkcol needs
  // them to build a target URL); this helper drives discovery/reconcile directly, so it
  // has to do the same write.
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

  test("moving a dav_objects row to another collection enqueues move, and the server reflects it", async () => {
    const [newCollection] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_collections (account_id, kind, slug, display_name)
      VALUES (${ctx.davAccountId}, 'calendar', 'personal', 'Personal Calendar')
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);
    const newCollectionRow = await ctx.db
      .selectFrom("dav_collections")
      .select("href")
      .where("id", "=", newCollection.id)
      .executeTakeFirstOrThrow();

    const obj = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "href", "collection_id"])
      .where("account_id", "=", ctx.davAccountId)
      .where("collection_id", "!=", newCollection.id)
      .executeTakeFirstOrThrow();
    const oldHref = obj.href as string;
    const oldCollectionId = obj.collection_id;

    await ctx.pgSql`UPDATE dav_objects SET collection_id = ${newCollection.id} WHERE id = ${obj.id}`;
    await makeOutbound().drain(ctx.davAccountId);

    const moved = await ctx.db
      .selectFrom("dav_objects")
      .select(["href", "collection_id"])
      .where("id", "=", obj.id)
      .executeTakeFirstOrThrow();
    expect(moved.collection_id).toBe(newCollection.id);
    expect(moved.href).not.toBe(oldHref);

    const newEtags = await client.listEtags(newCollectionRow.href as string);
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

  test("deleting a dav_collections row enqueues rmcol, tombstones its objects, and removes it from the server", async () => {
    const [collection] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_collections (account_id, kind, slug, display_name)
      VALUES (${ctx.davAccountId}, 'calendar', 'to-delete', 'To Delete')
      RETURNING id
    `;
    await makeOutbound().drain(ctx.davAccountId);
    const collectionRow = await ctx.db
      .selectFrom("dav_collections")
      .select("href")
      .where("id", "=", collection.id)
      .executeTakeFirstOrThrow();

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
    expect(discovered.some((c) => c.href === collectionRow.href)).toBe(false);
  });
});

describe("E2E: DAV account sync -- inbound", () => {
  test("an object created directly on the server is picked up by an incremental sync", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href", "sync_tier"])
      .where("account_id", "=", ctx.davAccountId)
      .where("kind", "=", "calendar")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(collection.sync_tier).toBe("sync");

    const uid = `e2e-inbound-${randomUUID()}`;
    const href = new URL(`${uid}.ics`, collection.href as string).toString();
    const put = await client.put(
      href,
      sampleEvent(uid, "External Event"),
      "text/calendar; charset=utf-8",
      {
        create: true,
      },
    );
    expect(put.ok).toBe(true);

    const collectionRow = {
      id: collection.id,
      account_id: ctx.davAccountId,
      href: collection.href as string,
      kind: "calendar",
      sync_tier: collection.sync_tier,
    };
    const result = await syncCollectionIncremental(ctx.db, client, collectionRow);
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

  test("an object deleted directly on the server is tombstoned by the next incremental sync", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select(["id", "href", "sync_tier"])
      .where("account_id", "=", ctx.davAccountId)
      .where("kind", "=", "calendar")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["id", "href"])
      .where("collection_id", "=", collection.id)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    await client.delete(row.href as string);

    const collectionRow = {
      id: collection.id,
      account_id: ctx.davAccountId,
      href: collection.href as string,
      kind: "calendar",
      sync_tier: collection.sync_tier,
    };
    await syncCollectionIncremental(ctx.db, client, collectionRow);

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
      .where("kind", "=", "calendar")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    const uid = `e2e-reconcile-${randomUUID()}`;
    const href = new URL(`${uid}.ics`, collection.href as string).toString();
    await client.put(href, sampleEvent(uid, "Reconciled Event"), "text/calendar; charset=utf-8", {
      create: true,
    });

    const collectionRow = {
      id: collection.id,
      account_id: ctx.davAccountId,
      href: collection.href as string,
      kind: "calendar",
      sync_tier: collection.sync_tier,
    };
    const result = await fullReconcile(ctx.db, client, collectionRow);
    expect(result.upserted).toBeGreaterThanOrEqual(1);

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select("summary")
      .where("collection_id", "=", collection.id)
      .where("uid", "=", uid)
      .executeTakeFirstOrThrow();
    expect(row.summary).toBe("Reconciled Event");
  });
});
