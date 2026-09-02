import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";
import type { DavClient, SyncCollectionEntry } from "./client.js";
import { type ParsedDavObject, parseObject } from "./codec.js";

const log = createLogger("dav-collection-sync");

interface CollectionRow {
  id: string;
  account_id: string;
  href: string | null;
  kind: string;
  sync_tier: string | null;
}

export interface CollectionSyncResult {
  upserted: number;
  tombstoned: number;
  errors: number;
}

const EMPTY_RESULT: CollectionSyncResult = { upserted: 0, tombstoned: 0, errors: 0 };

function parsedColumns(p: ParsedDavObject) {
  return {
    uid: p.uid,
    component: p.component,
    summary: p.summary,
    dtstart: p.dtstart,
    dtend: p.dtend,
    dtstart_tz: p.dtstartTz,
    all_day: p.allDay,
    is_recurring: p.isRecurring,
    has_exceptions: p.hasExceptions,
    status: p.status,
    sequence: p.sequence,
    organizer: p.organizer,
    attendees: p.attendees ? JSON.stringify(p.attendees) : null,
    emails: p.emails,
    last_modified: p.lastModified,
  };
}

/**
 * Upsert or tombstone every entry a sync-collection/multiget round produced, inside one
 * sync-writer transaction. `backfill` suppresses per-row events the same way an IMAP
 * folder's initial sync does -- a large address book would otherwise put one notification
 * per contact on the channel at once.
 */
async function applyEntries(
  db: Kysely<Database>,
  collection: CollectionRow,
  entries: SyncCollectionEntry[],
  backfill: boolean,
): Promise<CollectionSyncResult> {
  const kind = collection.kind as "calendar" | "addressbook";
  let upserted = 0;
  let tombstoned = 0;
  let errors = 0;

  await withSyncWriter(
    db,
    async (trx) => {
      for (const entry of entries) {
        try {
          if (entry.status === 404 || entry.data === null) {
            const result = await trx
              .updateTable("dav_objects")
              .set({ deleted_at: new Date() })
              .where("collection_id", "=", collection.id)
              .where("href", "=", entry.href)
              .where("deleted_at", "is", null)
              .executeTakeFirst();
            if ((result.numUpdatedRows ?? 0n) > 0n) tombstoned++;
            continue;
          }

          const parsed = parseObject(entry.data, kind);
          const cols = parsedColumns(parsed);

          const existing = await trx
            .selectFrom("dav_objects")
            .select("id")
            .where("collection_id", "=", collection.id)
            .where("href", "=", entry.href)
            .executeTakeFirst();

          if (existing) {
            await trx
              .updateTable("dav_objects")
              .set({ etag: entry.etag, data: entry.data, deleted_at: null, ...cols })
              .where("id", "=", existing.id)
              .execute();
          } else {
            await trx
              .insertInto("dav_objects")
              .values({
                account_id: collection.account_id,
                collection_id: collection.id,
                href: entry.href,
                etag: entry.etag,
                kind,
                data: entry.data,
                ...cols,
              })
              .execute();
          }
          upserted++;
        } catch (err) {
          errors++;
          log.error(
            { err, href: entry.href, collectionId: collection.id },
            "Failed to apply a DAV entry",
          );
        }
      }
    },
    { backfill },
  );

  return { upserted, tombstoned, errors };
}

/**
 * Initial sync of a collection. Tier `sync` takes the empty-token sync-collection REPORT
 * (returns every href with inline data in one round trip, and the current token). Tier
 * `ctag`/`full` lists etags, then fetches bodies via multiget in `multigetChunk`-sized
 * batches, so a very large collection never comes back as one response.
 */
export async function backfillCollection(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
  multigetChunk: number,
): Promise<CollectionSyncResult> {
  if (!collection.href) return EMPTY_RESULT;
  const kind = collection.kind as "calendar" | "addressbook";

  let result: CollectionSyncResult;
  let newToken: string | null = null;

  if (collection.sync_tier === "sync") {
    const sync = await client.syncCollectionReport(collection.href, kind, "");
    result = await applyEntries(db, collection, sync.entries, true);
    newToken = sync.syncToken;
  } else {
    const etags = await client.listEtags(collection.href);
    const hrefs = [...etags.keys()];
    let all: SyncCollectionEntry[] = [];
    for (let i = 0; i < hrefs.length; i += multigetChunk) {
      const chunk = hrefs.slice(i, i + multigetChunk);
      const fetched = await client.multiget(collection.href, chunk, kind);
      all = all.concat(fetched);
    }
    result = await applyEntries(db, collection, all, true);
  }

  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_collections")
      .set({
        sync_token: newToken,
        initial_sync_done: true,
        last_synced_at: new Date(),
        last_full_reconcile_at: new Date(),
        backfill_total: null,
        sync_error: null,
      })
      .where("id", "=", collection.id)
      .execute(),
  );

  return result;
}

/**
 * One incremental cycle. Tier `sync` REPORTs against the stored token; a `403
 * valid-sync-token` response means the token is no longer accepted (a restored backup, a
 * recreated calendar under the same URL) -- fall back to a full etag diff and take a fresh
 * token afterwards, rather than erroring the cycle.
 */
export async function syncCollectionIncremental(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
): Promise<CollectionSyncResult> {
  if (!collection.href) return EMPTY_RESULT;
  const kind = collection.kind as "calendar" | "addressbook";

  if (collection.sync_tier === "sync") {
    const token = await getStoredToken(db, collection.id);
    const sync = await client.syncCollectionReport(collection.href, kind, token ?? "");
    if (sync.tokenInvalid) {
      log.warn({ collectionId: collection.id }, "Stored sync-token no longer valid, reconciling");
      const result = await fullEtagDiff(db, client, collection);
      const fresh = await client.syncCollectionReport(collection.href, kind, "");
      await withSyncWriter(db, (trx) =>
        trx
          .updateTable("dav_collections")
          .set({ sync_token: fresh.syncToken, last_synced_at: new Date(), sync_error: null })
          .where("id", "=", collection.id)
          .execute(),
      );
      return result;
    }

    const result = await applyEntries(db, collection, sync.entries, false);
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ sync_token: sync.syncToken, last_synced_at: new Date(), sync_error: null })
        .where("id", "=", collection.id)
        .execute(),
    );
    return result;
  }

  const result = await fullEtagDiff(db, client, collection);
  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_collections")
      .set({ last_synced_at: new Date(), sync_error: null })
      .where("id", "=", collection.id)
      .execute(),
  );
  return result;
}

/**
 * Run this on every `full_reconcile_seconds` tick regardless of tier or token health --
 * the one thing that catches a server (observed on Nextcloud) that silently accepts an
 * unknown numeric sync-token and reports no changes instead of refusing it.
 */
export async function fullReconcile(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
): Promise<CollectionSyncResult> {
  const result = await fullEtagDiff(db, client, collection);
  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_collections")
      .set({ last_full_reconcile_at: new Date(), sync_error: null })
      .where("id", "=", collection.id)
      .execute(),
  );
  return result;
}

async function fullEtagDiff(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
): Promise<CollectionSyncResult> {
  if (!collection.href) return EMPTY_RESULT;
  const kind = collection.kind as "calendar" | "addressbook";

  const serverEtags = await client.listEtags(collection.href);
  const localRows = await db
    .selectFrom("dav_objects")
    .select(["href", "etag"])
    .where("collection_id", "=", collection.id)
    .where("deleted_at", "is", null)
    .where("href", "is not", null)
    .execute();
  const localByHref = new Map(localRows.map((r) => [r.href as string, r.etag]));

  const changedHrefs: string[] = [];
  for (const [href, etag] of serverEtags) {
    if (localByHref.get(href) !== etag) changedHrefs.push(href);
  }
  const removedHrefs = [...localByHref.keys()].filter((href) => !serverEtags.has(href));

  let entries: SyncCollectionEntry[] = [];
  const chunk = 50;
  for (let i = 0; i < changedHrefs.length; i += chunk) {
    const fetched = await client.multiget(collection.href, changedHrefs.slice(i, i + chunk), kind);
    entries = entries.concat(fetched);
  }
  for (const href of removedHrefs) {
    entries.push({ href, status: 404, etag: null, data: null });
  }

  return applyEntries(db, collection, entries, false);
}

async function getStoredToken(db: Kysely<Database>, collectionId: string): Promise<string | null> {
  const row = await db
    .selectFrom("dav_collections")
    .select("sync_token")
    .where("id", "=", collectionId)
    .executeTakeFirst();
  return row?.sync_token ?? null;
}
