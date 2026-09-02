import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";
import type { CollectionKind, DavClient, SyncCollectionEntry } from "./client.js";
import { type ParsedDavObject, parseObject } from "./codec.js";
import { getPendingHrefs } from "./loop-guard.js";

const log = createLogger("dav-collection-sync");

export interface CollectionRow {
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

function add(a: CollectionSyncResult, b: CollectionSyncResult): CollectionSyncResult {
  return {
    upserted: a.upserted + b.upserted,
    tombstoned: a.tombstoned + b.tombstoned,
    errors: a.errors + b.errors,
  };
}

export function parsedColumns(p: ParsedDavObject) {
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
 *
 * Only a 404 tombstones. A 2xx entry that arrived without a body is an error, never a
 * deletion -- a server that leaves `calendar-data` out of a response would otherwise
 * wipe the mirror. Hrefs with outbound work still queued are left alone (see
 * loop-guard.ts); a conflict on those is caught by the write's own If-Match.
 */
async function applyEntries(
  db: Kysely<Database>,
  collection: CollectionRow,
  entries: SyncCollectionEntry[],
  backfill: boolean,
  pendingHrefs: Set<string>,
): Promise<CollectionSyncResult> {
  if (entries.length === 0) return EMPTY_RESULT;
  const kind = collection.kind as CollectionKind;
  let upserted = 0;
  let tombstoned = 0;
  let errors = 0;

  await withSyncWriter(
    db,
    async (trx) => {
      for (const entry of entries) {
        try {
          if (entry.status === 404) {
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
          if (pendingHrefs.has(entry.href)) continue;
          if (entry.status >= 400 || entry.data === null) {
            errors++;
            log.warn(
              { href: entry.href, status: entry.status, collectionId: collection.id },
              "DAV entry carried no body",
            );
            continue;
          }

          const cols = parsedColumns(parseObject(entry.data, kind));
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

/** Fetch bodies for `hrefs` in `chunk`-sized multigets. */
async function multigetAll(
  client: DavClient,
  collectionHref: string,
  kind: CollectionKind,
  hrefs: string[],
  chunk: number,
): Promise<SyncCollectionEntry[]> {
  let all: SyncCollectionEntry[] = [];
  for (let i = 0; i < hrefs.length; i += chunk) {
    const fetched = await client.multiget(collectionHref, hrefs.slice(i, i + chunk), kind);
    all = all.concat(fetched);
  }
  return all;
}

/**
 * Initial sync of a collection: list etags, record the count as `backfill_total`, fetch
 * bodies by multiget in `multigetChunk`-sized batches -- each applied in its own
 * transaction so `total_count` advances as it goes -- then, on the `sync` tier, take the
 * current token from a data-less empty-token REPORT and fetch whatever changed under it.
 * One giant REPORT with inline data would return a large address book as a single
 * response, which is why the token comes last rather than first.
 */
export async function backfillCollection(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
  multigetChunk: number,
  serverCtag: string | null,
): Promise<CollectionSyncResult> {
  if (!collection.href) return EMPTY_RESULT;
  const href = collection.href;
  const kind = collection.kind as CollectionKind;
  const pending = await getPendingHrefs(db, collection.account_id);

  const etags = await client.listEtags(href);
  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_collections")
      .set({ backfill_total: etags.size })
      .where("id", "=", collection.id)
      .execute(),
  );

  let result = EMPTY_RESULT;
  const hrefs = [...etags.keys()];
  for (let i = 0; i < hrefs.length; i += multigetChunk) {
    const fetched = await client.multiget(href, hrefs.slice(i, i + multigetChunk), kind);
    result = add(result, await applyEntries(db, collection, fetched, true, pending));
  }

  let newToken: string | null = null;
  if (collection.sync_tier === "sync") {
    const report = await client.syncCollectionReport(href, kind, "", false);
    newToken = report.syncToken;
    const changed = report.entries
      .filter((e) => e.status < 400 && e.etag !== etags.get(e.href))
      .map((e) => e.href);
    const fetched = await multigetAll(client, href, kind, changed, multigetChunk);
    result = add(result, await applyEntries(db, collection, fetched, true, pending));
  }

  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_collections")
      .set({
        sync_token: newToken,
        ctag: serverCtag,
        initial_sync_done: true,
        last_synced_at: new Date(),
        last_full_reconcile_at: new Date(),
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
 * token afterwards, rather than erroring the cycle. The other tiers are the etag diff.
 */
export async function syncCollectionIncremental(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
  serverCtag: string | null,
): Promise<CollectionSyncResult> {
  if (!collection.href) return EMPTY_RESULT;
  const href = collection.href;
  const kind = collection.kind as CollectionKind;

  if (collection.sync_tier !== "sync") {
    const result = await fullEtagDiff(db, client, collection);
    await storeProgress(db, collection.id, { ctag: serverCtag });
    return result;
  }

  const token = await getStoredToken(db, collection.id);
  const sync = await client.syncCollectionReport(href, kind, token ?? "");
  if (sync.tokenInvalid) {
    log.warn({ collectionId: collection.id }, "Stored sync-token no longer valid, reconciling");
    const result = await fullEtagDiff(db, client, collection);
    const fresh = await client.syncCollectionReport(href, kind, "", false);
    await storeProgress(db, collection.id, { sync_token: fresh.syncToken, ctag: serverCtag });
    return result;
  }

  // A server that honours sync-collection but not inline data answers 2xx without a
  // body; fetch those the ordinary way rather than treating them as errors.
  const pending = await getPendingHrefs(db, collection.account_id);
  const withBody = sync.entries.filter((e) => e.status >= 400 || e.data !== null);
  const bodiless = sync.entries
    .filter((e) => e.status < 400 && e.data === null && !pending.has(e.href))
    .map((e) => e.href);
  const fetched = await multigetAll(client, href, kind, bodiless, 50);
  const result = await applyEntries(db, collection, [...withBody, ...fetched], false, pending);
  await storeProgress(db, collection.id, { sync_token: sync.syncToken, ctag: serverCtag });
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
  serverCtag: string | null,
): Promise<CollectionSyncResult> {
  const result = await fullEtagDiff(db, client, collection);
  await storeProgress(db, collection.id, {
    ctag: serverCtag,
    last_full_reconcile_at: new Date(),
  });
  return result;
}

async function fullEtagDiff(
  db: Kysely<Database>,
  client: DavClient,
  collection: CollectionRow,
): Promise<CollectionSyncResult> {
  if (!collection.href) return EMPTY_RESULT;
  const kind = collection.kind as CollectionKind;
  const pending = await getPendingHrefs(db, collection.account_id);

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
    if (pending.has(href)) continue;
    if (localByHref.get(href) !== etag) changedHrefs.push(href);
  }
  const removedHrefs = [...localByHref.keys()].filter(
    (href) => !serverEtags.has(href) && !pending.has(href),
  );

  const entries = await multigetAll(client, collection.href, kind, changedHrefs, 50);
  for (const href of removedHrefs) {
    entries.push({ href, status: 404, etag: null, data: null });
  }

  return applyEntries(db, collection, entries, false, pending);
}

async function storeProgress(
  db: Kysely<Database>,
  collectionId: string,
  values: { sync_token?: string | null; ctag?: string | null; last_full_reconcile_at?: Date },
): Promise<void> {
  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_collections")
      .set({ ...values, last_synced_at: new Date(), sync_error: null })
      .where("id", "=", collectionId)
      .execute(),
  );
}

async function getStoredToken(db: Kysely<Database>, collectionId: string): Promise<string | null> {
  const row = await db
    .selectFrom("dav_collections")
    .select("sync_token")
    .where("id", "=", collectionId)
    .executeTakeFirst();
  return row?.sync_token ?? null;
}
