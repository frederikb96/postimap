import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import type { CollectionKind, DavClient } from "./client.js";
import { parseObject, suggestFilename } from "./codec.js";
import { parsedColumns } from "./collection-sync.js";

const log = createLogger("dav-outbound");

const BATCH_SIZE = 10;

interface QueueEntry {
  id: string;
  account_id: string;
  collection_id: string | null;
  object_id: string | null;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
}

function contentTypeFor(kind: string): string {
  return kind === "calendar" ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8";
}

function joinHref(collectionHref: string, name: string): string {
  return new URL(
    name,
    collectionHref.endsWith("/") ? collectionHref : `${collectionHref}/`,
  ).toString();
}

/**
 * DAV outbound queue processor: consumes `dav_sync_queue` and applies each entry to the
 * server. Mirrors `sync/outbound.ts` -- LISTEN/NOTIFY wakeup per account with a polling
 * fallback, `FOR UPDATE SKIP LOCKED` claim, server-wins conflict handling on `412`.
 */
export class DavOutboundProcessor {
  private subscriber: Subscriber | null = null;
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private subscribedChannels = new Set<string>();
  private processing = new Set<string>();

  constructor(
    private db: Kysely<Database>,
    private databaseUrl: string,
    private getClient: (accountId: string) => DavClient,
    private pollIntervalMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.subscriber = await createPgListener(this.databaseUrl);
    await this.subscriber.connect();

    const accounts = await this.db
      .selectFrom("dav_accounts")
      .select("id")
      .where("is_active", "=", true)
      .execute();
    for (const account of accounts) {
      await this.subscribeAccount(account.id);
    }
    log.info(
      { accountCount: accounts.length, pollIntervalMs: this.pollIntervalMs },
      "DAV outbound processor started",
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const [, timer] of this.pollTimers) clearInterval(timer);
    this.pollTimers.clear();

    if (this.subscriber) {
      const sub = this.subscriber;
      this.subscriber = null;
      try {
        await Promise.race([
          (async () => {
            try {
              await sub.unlistenAll();
            } catch {}
            await sub.close();
          })(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      } catch {}
    }
    this.subscribedChannels.clear();
    this.processing.clear();
    log.info("DAV outbound processor stopped");
  }

  async subscribeAccount(accountId: string): Promise<void> {
    const channel = `dav_sync_queue_${accountId}`;
    if (!this.subscribedChannels.has(channel) && this.subscriber) {
      this.subscriber.notifications.on(channel, () => this.scheduleBatch(accountId));
      await this.subscriber.listenTo(channel);
      this.subscribedChannels.add(channel);
    }
    if (!this.pollTimers.has(accountId)) {
      const timer = setInterval(() => this.scheduleBatch(accountId), this.pollIntervalMs);
      this.pollTimers.set(accountId, timer);
    }
    this.scheduleBatch(accountId);
  }

  async unsubscribeAccount(accountId: string): Promise<void> {
    const channel = `dav_sync_queue_${accountId}`;
    if (this.subscribedChannels.has(channel) && this.subscriber) {
      await this.subscriber.unlisten(channel);
      this.subscribedChannels.delete(channel);
    }
    const timer = this.pollTimers.get(accountId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(accountId);
    }
  }

  private scheduleBatch(accountId: string): void {
    if (!this.running) return;
    if (this.processing.has(accountId)) return;
    this.processing.add(accountId);
    this.processBatch(accountId)
      .catch((err) => log.error({ err, accountId }, "DAV batch processing failed"))
      .finally(() => this.processing.delete(accountId));
  }

  /** Drains everything pending for an account, for tests and manual triggers. */
  async drain(accountId: string): Promise<number> {
    const wasRunning = this.running;
    this.running = true;
    try {
      let total = 0;
      while (true) {
        const n = await this.processBatch(accountId);
        if (n === 0) break;
        total += n;
      }
      return total;
    } finally {
      this.running = wasRunning;
    }
  }

  private async processBatch(accountId: string): Promise<number> {
    const claimed = await this.db.transaction().execute(async (trx) => {
      const rows = await sql<QueueEntry>`
        SELECT id, account_id, collection_id, object_id, action, payload, status, attempts, max_attempts
        FROM dav_sync_queue
        WHERE account_id = ${accountId}
          AND status IN ('pending', 'failed')
          AND next_retry_at <= now()
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${sql.lit(BATCH_SIZE)}
      `.execute(trx);
      if (rows.rows.length === 0) return [];
      const ids = rows.rows.map((r) => r.id);
      await trx
        .updateTable("dav_sync_queue")
        .set({ status: "processing" })
        .where("id", "in", ids)
        .execute();
      return rows.rows;
    });

    if (claimed.length === 0) return 0;

    for (const entry of claimed) {
      if (!this.running) break;
      await this.processEntry(accountId, entry);
    }
    return claimed.length;
  }

  private async processEntry(accountId: string, entry: QueueEntry): Promise<void> {
    try {
      const client = this.getClient(accountId);
      switch (entry.action) {
        case "put":
          await this.processPut(client, entry);
          break;
        case "move":
          await this.processMove(client, entry);
          break;
        case "delete":
          await this.processDelete(client, entry);
          break;
        case "mkcol":
          await this.processMkcol(client, entry);
          break;
        case "proppatch":
          await this.processProppatch(client, entry);
          break;
        case "rmcol":
          await this.processRmcol(client, entry);
          break;
        default:
          await this.markDead(entry, `Unknown action: ${entry.action}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, entryId: entry.id, action: entry.action }, "DAV outbound operation failed");
      await this.markFailed(entry, errMsg);
    }
  }

  private async processPut(client: DavClient, entry: QueueEntry): Promise<void> {
    if (!entry.object_id) {
      await this.markDead(entry, "put entry carries no object_id");
      return;
    }
    const object = await this.db
      .selectFrom("dav_objects")
      .select(["id", "collection_id", "href", "etag", "data", "kind", "deleted_at"])
      .where("id", "=", entry.object_id)
      .executeTakeFirst();
    if (!object) {
      await this.markDead(entry, "Object row is gone");
      return;
    }
    if (object.deleted_at) {
      await this.markCompleted(entry);
      return;
    }

    const collection = await this.getCollection(object.collection_id);
    if (!collection?.href) {
      // The collection hasn't been created on the server yet (its own mkcol is still
      // pending or retrying) -- this is recoverable, not a failure to give up on.
      await this.markFailed(entry, "Target collection has no href yet");
      return;
    }

    const kind = object.kind as CollectionKind;
    const parsed = parseObject(object.data, kind);
    const creating = !object.href;
    const targetUrl = object.href ?? joinHref(collection.href, suggestFilename(parsed.uid, kind));

    const result = await client.put(targetUrl, object.data, contentTypeFor(kind), {
      ifMatch: creating ? undefined : (object.etag ?? undefined),
      create: creating,
    });

    if (result.status === 412) {
      if (creating) {
        // If-None-Match: * refused -- the server already holds a resource at the href this
        // UID maps to. Nothing of the consumer's exists on the server to revert to.
        await this.markDead(entry, `An object already exists at ${targetUrl}`);
        return;
      }
      const reverted = await this.revertToServer(client, object.id, targetUrl, kind);
      await this.recordNotification(
        entry,
        "The server had a newer version; your changes were discarded",
        reverted,
      );
      await this.markCompleted(entry);
      return;
    }
    if (!result.ok) {
      if (creating && result.status >= 400 && result.status < 500) {
        await this.markDead(entry, `Server refused to create the object (HTTP ${result.status})`);
        return;
      }
      await this.markFailed(entry, `PUT returned HTTP ${result.status}`);
      return;
    }

    // sabre omits the ETag on a PUT whose body it rewrote -- re-read it rather than
    // leaving the row believing nothing changed.
    const etag = result.etag ?? (await client.getEtag(targetUrl));
    await withSyncWriter(this.db, async (trx) => {
      await claimHref(trx, object.id, object.collection_id, targetUrl);
      await trx
        .updateTable("dav_objects")
        .set({ href: targetUrl, etag, ...parsedColumns(parsed) })
        .where("id", "=", object.id)
        .execute();
    });
    await this.markCompleted(entry);
  }

  /**
   * Server wins: re-read the server's copy of `href` over the row. Returns whether the row
   * now reflects the server -- false when the copy could not be read, in which case the
   * consumer's value is still in the column and the notification says so.
   */
  private async revertToServer(
    client: DavClient,
    objectId: string,
    href: string,
    kind: CollectionKind,
  ): Promise<boolean> {
    try {
      const [fresh] = await client.multiget(new URL(".", href).toString(), [href], kind);
      if (!fresh?.data) return false;
      const data = fresh.data;
      const etag = fresh.etag ?? (await client.getEtag(href));
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("dav_objects")
          .set({ data, etag, deleted_at: null, ...parsedColumns(parseObject(data, kind)) })
          .where("id", "=", objectId)
          .execute(),
      );
      return true;
    } catch (err) {
      log.warn({ err, objectId }, "Could not re-read the server's copy after a conflict");
      return false;
    }
  }

  private async processMove(client: DavClient, entry: QueueEntry): Promise<void> {
    if (!entry.object_id) {
      await this.markDead(entry, "move entry carries no object_id");
      return;
    }
    const object = await this.db
      .selectFrom("dav_objects")
      .select(["id", "collection_id", "href", "kind", "deleted_at"])
      .where("id", "=", entry.object_id)
      .executeTakeFirst();
    if (!object) {
      await this.markDead(entry, "Object row is gone");
      return;
    }
    const oldHref = entry.payload.old_href as string | undefined;
    if (!oldHref || object.deleted_at) {
      // Never on the server at the source: the queued put creates it wherever the row
      // points now. A tombstoned row has its delete queued behind this entry.
      await this.markCompleted(entry);
      return;
    }
    const collection = await this.getCollection(object.collection_id);
    if (!collection?.href) {
      await this.markFailed(entry, "Target collection has no href yet");
      return;
    }

    const kind = object.kind as CollectionKind;
    const filename = oldHref.split("/").filter(Boolean).pop() ?? "";
    const destUrl = joinHref(collection.href, filename);

    const moveResult = await client.move(oldHref, destUrl);
    if (moveResult.status === 405 || moveResult.status === 501) {
      // Fallback for a server without MOVE: fetch, PUT at the destination, DELETE the source.
      const [fetched] = await client.multiget(new URL(".", oldHref).toString(), [oldHref], kind);
      if (!fetched?.data) {
        await this.markFailed(entry, "MOVE unsupported and the source object could not be re-read");
        return;
      }
      const put = await client.put(destUrl, fetched.data, contentTypeFor(kind), { create: true });
      if (!put.ok) {
        await this.markFailed(entry, `Fallback PUT at destination returned HTTP ${put.status}`);
        return;
      }
      await client.delete(oldHref).catch(() => undefined);
    } else if (moveResult.status === 404) {
      // The source is gone. Either an earlier move in the same batch already carried the
      // object here (A->B->C captures A as the source twice), or the server removed it --
      // in which case the server wins and the row is tombstoned.
      const there = await client.getEtag(destUrl);
      if (there === null) {
        await withSyncWriter(this.db, (trx) =>
          trx
            .updateTable("dav_objects")
            .set({ deleted_at: new Date() })
            .where("id", "=", object.id)
            .execute(),
        );
        await this.recordNotification(entry, "The object no longer exists on the server", true);
        await this.markCompleted(entry);
        return;
      }
    } else if (!moveResult.ok) {
      await this.markFailed(entry, `MOVE returned HTTP ${moveResult.status}`);
      return;
    }

    const etag = await client.getEtag(destUrl);
    await withSyncWriter(this.db, async (trx) => {
      await claimHref(trx, object.id, object.collection_id, destUrl);
      await trx
        .updateTable("dav_objects")
        .set({ href: destUrl, etag })
        .where("id", "=", object.id)
        .execute();
    });
    await this.markCompleted(entry);
  }

  private async processDelete(client: DavClient, entry: QueueEntry): Promise<void> {
    const href = entry.payload.href as string | undefined;
    if (!href) {
      // Nothing was ever created on the server for this row -- deleting locally is enough.
      await this.markCompleted(entry);
      return;
    }
    const etag = entry.payload.etag as string | undefined;
    const result = await client.delete(href, etag);
    if (result.status === 412 && entry.object_id) {
      // Changed on the server since the consumer last saw it: the server's version comes
      // back into the row, un-tombstoned, and the consumer is told its delete did not land.
      const object = await this.db
        .selectFrom("dav_objects")
        .select("kind")
        .where("id", "=", entry.object_id)
        .executeTakeFirst();
      const reverted = object
        ? await this.revertToServer(client, entry.object_id, href, object.kind as CollectionKind)
        : false;
      await this.recordNotification(
        entry,
        "The server had a newer version; the delete was discarded",
        reverted,
      );
      await this.markCompleted(entry);
      return;
    }
    if (!result.ok && result.status !== 404) {
      await this.markFailed(entry, `DELETE returned HTTP ${result.status}`);
      return;
    }
    await this.markCompleted(entry);
  }

  private async processMkcol(client: DavClient, entry: QueueEntry): Promise<void> {
    if (!entry.collection_id) {
      await this.markDead(entry, "mkcol entry carries no collection_id");
      return;
    }
    const collection = await this.db
      .selectFrom("dav_collections")
      .select(["id", "account_id", "kind", "slug", "display_name", "href"])
      .where("id", "=", entry.collection_id)
      .executeTakeFirst();
    if (!collection) {
      await this.markDead(entry, "Collection row is gone");
      return;
    }
    if (collection.href) {
      await this.markCompleted(entry);
      return;
    }

    const account = await this.db
      .selectFrom("dav_accounts")
      .select(["calendar_home_url", "addressbook_home_url"])
      .where("id", "=", collection.account_id)
      .executeTakeFirst();
    const home =
      collection.kind === "calendar" ? account?.calendar_home_url : account?.addressbook_home_url;
    if (!home) {
      await this.markFailed(entry, "No home collection URL discovered yet for this account");
      return;
    }

    const url = joinHref(home, `${collection.slug}/`);
    const displayName = collection.display_name ?? collection.slug;
    const result =
      collection.kind === "calendar"
        ? await client.mkcalendar(url, displayName)
        : await client.mkAddressbook(url, displayName);

    if (!result.ok) {
      // 405 (sabre) or 409 (Radicale) is what "already exists" looks like, but 409 is also
      // "parent missing" -- only adopt what is actually there.
      const exists = (result.status === 405 || result.status === 409) && (await client.exists(url));
      if (!exists) {
        await this.markFailed(entry, `Collection create returned HTTP ${result.status}`);
        return;
      }
    }

    await withSyncWriter(this.db, async (trx) => {
      // Discovery may have mirrored this href as its own row between the server accepting
      // the MKCOL and this write; fold that row into the consumer's rather than keeping two.
      const duplicate = await trx
        .selectFrom("dav_collections")
        .select("id")
        .where("account_id", "=", collection.account_id)
        .where("href", "=", url)
        .where("deleted_at", "is", null)
        .where("id", "!=", collection.id)
        .executeTakeFirst();
      if (duplicate) {
        await trx
          .updateTable("dav_objects")
          .set({ collection_id: collection.id })
          .where("collection_id", "=", duplicate.id)
          .execute();
        await trx.deleteFrom("dav_collections").where("id", "=", duplicate.id).execute();
      }
      await trx
        .updateTable("dav_collections")
        .set({ href: url })
        .where("id", "=", collection.id)
        .execute();
    });
    await this.markCompleted(entry);
  }

  private async processProppatch(client: DavClient, entry: QueueEntry): Promise<void> {
    if (!entry.collection_id) {
      await this.markDead(entry, "proppatch entry carries no collection_id");
      return;
    }
    const collection = await this.db
      .selectFrom("dav_collections")
      .select(["href", "kind"])
      .where("id", "=", entry.collection_id)
      .executeTakeFirst();
    if (!collection?.href) {
      await this.markFailed(entry, "Collection has no href yet");
      return;
    }
    // The payload holds what the consumer wrote at the time; the row may since have been
    // refreshed from the server by reconciliation.
    const result = await client.proppatch(collection.href, collection.kind as CollectionKind, {
      displayName: entry.payload.display_name as string | null | undefined,
      color: entry.payload.color as string | null | undefined,
      description: entry.payload.description as string | null | undefined,
    });
    if (!result.ok) {
      await this.markFailed(entry, `PROPPATCH returned HTTP ${result.status}`);
      return;
    }
    await this.markCompleted(entry);
  }

  private async processRmcol(client: DavClient, entry: QueueEntry): Promise<void> {
    const href = entry.payload.href as string | undefined;
    if (!href) {
      await this.markCompleted(entry);
      return;
    }
    const result = await client.removeCollection(href);
    if (!result.ok && result.status !== 404) {
      await this.markFailed(entry, `Collection delete returned HTTP ${result.status}`);
      return;
    }
    if (entry.collection_id) {
      await withSyncWriter(
        this.db,
        (trx) =>
          trx
            .updateTable("dav_objects")
            .set({ deleted_at: new Date() })
            .where("collection_id", "=", entry.collection_id as string)
            .where("deleted_at", "is", null)
            .execute(),
        { backfill: true },
      );
    }
    await this.markCompleted(entry);
  }

  private async getCollection(collectionId: string): Promise<{ href: string | null } | null> {
    const row = await this.db
      .selectFrom("dav_collections")
      .select("href")
      .where("id", "=", collectionId)
      .executeTakeFirst();
    return row ?? null;
  }

  private async markCompleted(entry: QueueEntry): Promise<void> {
    await this.db
      .updateTable("dav_sync_queue")
      .set({ status: "completed", processed_at: new Date(), error: null })
      .where("id", "=", entry.id)
      .execute();
  }

  private async markFailed(entry: QueueEntry, error: string): Promise<void> {
    const attempts = entry.attempts + 1;
    if (attempts >= entry.max_attempts) {
      await this.markDead(entry, error);
      return;
    }
    const delay = computeDelay(attempts, {
      maxRetries: entry.max_attempts,
      baseDelay: 1_000,
      maxDelay: 300_000,
      jitter: true,
    });
    await this.db
      .updateTable("dav_sync_queue")
      .set({ status: "failed", attempts, error, next_retry_at: new Date(Date.now() + delay) })
      .where("id", "=", entry.id)
      .execute();
  }

  private async markDead(entry: QueueEntry, error: string): Promise<void> {
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("dav_sync_queue")
        .set({ status: "dead", attempts: entry.attempts + 1, error, processed_at: new Date() })
        .where("id", "=", entry.id)
        .execute(),
    );

    // A create that never reached the server has nothing to revert to on the server side
    // -- tombstone the row so reconciliation does not carry an href-less object forever.
    if (entry.action === "put" && entry.object_id) {
      const object = await this.db
        .selectFrom("dav_objects")
        .select("href")
        .where("id", "=", entry.object_id)
        .executeTakeFirst();
      if (object && !object.href) {
        await withSyncWriter(this.db, (trx) =>
          trx
            .updateTable("dav_objects")
            .set({ deleted_at: new Date() })
            .where("id", "=", entry.object_id as string)
            .execute(),
        );
      }
    }

    await this.recordNotification(entry, error, false);
    log.error(
      { entryId: entry.id, action: entry.action, error },
      "DAV outbound entry dead-lettered",
    );
  }

  private async recordNotification(
    entry: QueueEntry,
    error: string,
    reverted: boolean,
  ): Promise<void> {
    try {
      await withSyncWriter(this.db, (trx) =>
        trx
          .insertInto("dav_notifications")
          .values({
            account_id: entry.account_id,
            action: entry.action,
            collection_id: entry.collection_id,
            object_id: entry.object_id,
            error,
            detail: { attempted: entry.payload, attempts: entry.attempts + 1 },
            reverted_at: reverted ? new Date() : null,
          })
          .execute(),
      );
    } catch (err) {
      log.error({ err, entryId: entry.id }, "Failed to record a DAV notification");
    }
  }
}

/**
 * Remove any other row already holding `(collection_id, href)` -- an inbound sync that ran
 * between the server accepting a write and this write-back mirrors the same resource as a
 * second row, and the partial unique index would otherwise refuse the write-back forever.
 */
async function claimHref(
  trx: Kysely<Database>,
  objectId: string,
  collectionId: string,
  href: string,
): Promise<void> {
  await trx
    .deleteFrom("dav_objects")
    .where("collection_id", "=", collectionId)
    .where("href", "=", href)
    .where("id", "!=", objectId)
    .execute();
}
