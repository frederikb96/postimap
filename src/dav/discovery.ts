import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";
import type { CollectionEntry, CollectionKind, DavClient } from "./client.js";
import { getPendingPropCollections } from "./loop-guard.js";
import { type SyncTier, selectTier } from "./tier.js";

const log = createLogger("dav-discovery");

export interface AccountHomes {
  principalUrl: string | null;
  calendarHomeUrl: string | null;
  addressbookHomeUrl: string | null;
}

/** current-user-principal -> calendar-home-set / addressbook-home-set. */
export async function discoverHomes(client: DavClient): Promise<AccountHomes> {
  const principalUrl = await client.currentUserPrincipal();
  if (!principalUrl) {
    return { principalUrl: null, calendarHomeUrl: null, addressbookHomeUrl: null };
  }
  const { calendarHome, addressbookHome } = await client.homeSets(principalUrl);
  return { principalUrl, calendarHomeUrl: calendarHome, addressbookHomeUrl: addressbookHome };
}

export interface DiscoveredCollection extends CollectionEntry {
  kind: CollectionKind;
  tier: SyncTier;
  readOnly: boolean;
}

/** List and classify every real calendar/addressbook under a home -- never the home itself. */
export async function discoverCollections(
  client: DavClient,
  homeUrl: string,
  kind: CollectionKind,
): Promise<DiscoveredCollection[]> {
  const entries = await client.listCollections(homeUrl, kind);
  return entries.map((e) => ({
    ...e,
    kind,
    tier: selectTier({
      supportedReports: e.supportedReports,
      syncToken: e.syncToken,
      ctag: e.ctag,
    }),
    // "all" or "write"/"writeContent" grants a consumer write access; its absence is the
    // only signal available without a dedicated ACL read, which Nextcloud's own birthday
    // calendar and shared-read-only collections both rely on.
    readOnly: !(e.privileges.includes("all") || e.privileges.includes("write")),
  }));
}

/** The last path segment of a collection href, used as `slug` when reconciling. */
export function slugFromHref(href: string): string {
  const path = new URL(href).pathname;
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** What the home listing reported for a collection this cycle, keyed by `dav_collections.id`. */
export interface ServerCollectionState {
  syncToken: string | null;
  ctag: string | null;
}

/**
 * Reconcile discovered collections into `dav_collections`: insert new, tombstone absent,
 * un-tombstone reappeared, refresh mutable properties. Mirrors
 * AccountSync.discoverAndSyncFolders() on the IMAP side.
 *
 * A row the consumer created (`href IS NULL`) whose slug and kind match a discovered
 * collection is adopted rather than duplicated: the outbound `mkcol` that created it on
 * the server may not have written the href back yet when discovery runs. A row with a
 * queued PROPPATCH keeps the properties the consumer wrote until that lands.
 */
export async function reconcileCollections(
  db: Kysely<Database>,
  accountId: string,
  discovered: DiscoveredCollection[],
): Promise<Map<string, ServerCollectionState>> {
  const existing = await db
    .selectFrom("dav_collections")
    .select(["id", "href", "kind", "slug", "deleted_at"])
    .where("account_id", "=", accountId)
    .execute();
  const byHref = new Map(existing.filter((e) => e.href).map((e) => [e.href as string, e]));
  const unplaced = existing.filter((e) => !e.href && !e.deleted_at);
  const propsPending = await getPendingPropCollections(db, accountId);

  const serverState = new Map<string, ServerCollectionState>();
  const seenHrefs = new Set<string>();
  for (const d of discovered) {
    seenHrefs.add(d.href);
    const state = { syncToken: d.syncToken, ctag: d.ctag };
    const serverProps = {
      display_name: d.displayName,
      color: d.color,
      description: d.description,
    };
    const row = byHref.get(d.href);

    if (row) {
      await withSyncWriter(db, (trx) =>
        trx
          .updateTable("dav_collections")
          .set({
            ...(propsPending.has(row.id) ? {} : serverProps),
            supported_components: d.supportedComponents.length > 0 ? d.supportedComponents : null,
            read_only: d.readOnly,
            sync_tier: d.tier,
            deleted_at: null,
          })
          .where("id", "=", row.id)
          .execute(),
      );
      serverState.set(row.id, state);
      continue;
    }

    const slug = slugFromHref(d.href);
    const adoptable = unplaced.find((e) => e.kind === d.kind && e.slug === slug);
    if (adoptable) {
      await withSyncWriter(db, (trx) =>
        trx
          .updateTable("dav_collections")
          .set({
            href: d.href,
            supported_components: d.supportedComponents.length > 0 ? d.supportedComponents : null,
            read_only: d.readOnly,
            sync_tier: d.tier,
          })
          .where("id", "=", adoptable.id)
          .execute(),
      );
      unplaced.splice(unplaced.indexOf(adoptable), 1);
      serverState.set(adoptable.id, state);
      log.info({ accountId, href: d.href, collectionId: adoptable.id }, "Adopted a collection");
      continue;
    }

    const inserted = await withSyncWriter(db, (trx) =>
      trx
        .insertInto("dav_collections")
        .values({
          account_id: accountId,
          kind: d.kind,
          href: d.href,
          slug,
          ...serverProps,
          supported_components: d.supportedComponents.length > 0 ? d.supportedComponents : null,
          read_only: d.readOnly,
          sync_tier: d.tier,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    serverState.set(inserted.id, state);
    log.info(
      { accountId, href: d.href, kind: d.kind, tier: d.tier },
      "Discovered a new collection",
    );
  }

  // A row created by a consumer (href IS NULL, not yet on the server) is never tombstoned
  // here -- the outbound mkcol has not run yet, or is still retrying.
  const gone = existing.filter((e) => e.href && !seenHrefs.has(e.href) && !e.deleted_at);
  for (const row of gone) {
    await withSyncWriter(db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ deleted_at: new Date() })
        .where("id", "=", row.id)
        .execute(),
    );
    log.info({ accountId, collectionId: row.id }, "Collection absent from discovery, tombstoned");
  }

  return serverState;
}
