import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Subscriber } from "pg-listen";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";
import type { DavClient } from "./client.js";
import { parseObject, suggestFilename } from "./codec.js";

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
        ORDER BY created_at
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

    const kind = object.kind as "calendar" | "addressbook";
    const contentType =
      kind === "calendar" ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8";

    let targetUrl: string;
    let creating: boolean;
    if (object.href) {
      targetUrl = object.href;
      creating = false;
    } else {
      const parsed = parseObject(object.data, kind);
      const filename = suggestFilename(parsed.uid, kind);
      targetUrl = new URL(
        filename,
        collection.href.endsWith("/") ? collection.href : `${collection.href}/`,
      ).toString();
      creating = true;
    }

    const result = await client.put(targetUrl, object.data, contentType, {
      ifMatch: creating ? undefined : (object.etag ?? undefined),
      create: creating,
    });

    if (result.status === 412) {
      await this.revertPutConflict(client, entry, object, collection.href);
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

    const etag = result.etag ?? (await this.readEtag(client, targetUrl));
    const parsed = parseObject(object.data, kind);
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("dav_objects")
        .set({
          href: targetUrl,
          etag,
          uid: parsed.uid,
          component: parsed.component,
          summary: parsed.summary,
          dtstart: parsed.dtstart,
          dtend: parsed.dtend,
          dtstart_tz: parsed.dtstartTz,
          all_day: parsed.allDay,
          is_recurring: parsed.isRecurring,
          has_exceptions: parsed.hasExceptions,
          status: parsed.status,
          sequence: parsed.sequence,
          organizer: parsed.organizer,
          attendees: parsed.attendees ? JSON.stringify(parsed.attendees) : null,
          emails: parsed.emails,
          last_modified: parsed.lastModified,
        })
        .where("id", "=", object.id)
        .execute(),
    );
    await this.markCompleted(entry);
  }

  private async readEtag(client: DavClient, url: string): Promise<string | null> {
    // Some servers (sabre/Nextcloud, by its own documentation) omit ETag on a PUT that
    // rewrote the body -- re-read it rather than leaving the row believing nothing changed.
    try {
      const etags = await client.listEtags(new URL(".", url).toString());
      return etags.get(url) ?? null;
    } catch {
      return null;
    }
  }

  private async revertPutConflict(
    client: DavClient,
    entry: QueueEntry,
    object: { id: string; collection_id: string; kind: string },
    collectionHref: string,
  ): Promise<void> {
    // The server changed the object first. Server wins, same as IMAP: re-read its copy
    // over the row and tell the consumer their version is gone.
    const objectRow = await this.db
      .selectFrom("dav_objects")
      .select(["href"])
      .where("id", "=", object.id)
      .executeTakeFirst();
    let reverted = false;
    if (objectRow?.href) {
      try {
        const etags = await client.listEtags(collectionHref);
        const fresh = await client.multiget(
          collectionHref,
          [objectRow.href],
          object.kind as "calendar" | "addressbook",
        );
        const entryData = fresh[0];
        if (entryData?.data) {
          const parsed = parseObject(entryData.data, object.kind as "calendar" | "addressbook");
          await withSyncWriter(this.db, (trx) =>
            trx
              .updateTable("dav_objects")
              .set({
                data: entryData.data as string,
                etag: entryData.etag ?? etags.get(objectRow.href as string) ?? null,
                uid: parsed.uid,
                summary: parsed.summary,
                dtstart: parsed.dtstart,
                dtend: parsed.dtend,
                status: parsed.status,
                sequence: parsed.sequence,
              })
              .where("id", "=", object.id)
              .execute(),
          );
          reverted = true;
        }
      } catch (err) {
        log.warn(
          { err, objectId: object.id },
          "Could not re-read the server's copy after a conflict",
        );
      }
    }

    await this.recordNotification(
      entry,
      "The server had a newer version; your changes were discarded",
      reverted,
    );
    await this.markCompleted(entry);
  }

  private async processMove(client: DavClient, entry: QueueEntry): Promise<void> {
    if (!entry.object_id) {
      await this.markDead(entry, "move entry carries no object_id");
      return;
    }
    const object = await this.db
      .selectFrom("dav_objects")
      .select(["id", "collection_id", "href", "kind"])
      .where("id", "=", entry.object_id)
      .executeTakeFirst();
    if (!object) {
      await this.markDead(entry, "Object row is gone");
      return;
    }
    const oldHref = entry.payload.old_href as string | undefined;
    if (!oldHref) {
      await this.markDead(entry, "move entry carries no source href");
      return;
    }
    const collection = await this.getCollection(object.collection_id);
    if (!collection?.href) {
      await this.markFailed(entry, "Target collection has no href yet");
      return;
    }

    const filename = oldHref.split("/").filter(Boolean).pop() ?? "";
    const destUrl = new URL(
      filename,
      collection.href.endsWith("/") ? collection.href : `${collection.href}/`,
    ).toString();

    const moveResult = await client.move(oldHref, destUrl);
    if (moveResult.status === 405 || moveResult.status === 501) {
      // Fallback for a server without MOVE: fetch, PUT at the destination, DELETE the source.
      const [fetched] = await client.multiget(
        new URL(".", oldHref).toString(),
        [oldHref],
        object.kind as "calendar" | "addressbook",
      );
      if (!fetched?.data) {
        await this.markFailed(entry, "MOVE unsupported and the source object could not be re-read");
        return;
      }
      const contentType =
        object.kind === "calendar" ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8";
      const put = await client.put(destUrl, fetched.data, contentType, { create: true });
      if (!put.ok) {
        await this.markFailed(entry, `Fallback PUT at destination returned HTTP ${put.status}`);
        return;
      }
      await client.delete(oldHref).catch(() => undefined);
    } else if (!moveResult.ok && moveResult.status !== 404) {
      await this.markFailed(entry, `MOVE returned HTTP ${moveResult.status}`);
      return;
    }

    const etag = await this.readEtag(client, destUrl);
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("dav_objects")
        .set({ href: destUrl, etag })
        .where("id", "=", object.id)
        .execute(),
    );
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

    const url = new URL(`${collection.slug}/`, home.endsWith("/") ? home : `${home}/`).toString();
    const displayName = collection.display_name ?? collection.slug;
    const result =
      collection.kind === "calendar"
        ? await client.mkcalendar(url, displayName)
        : await client.mkAddressbook(url, displayName);

    if (!result.ok && result.status !== 405) {
      await this.markFailed(entry, `Collection create returned HTTP ${result.status}`);
      return;
    }

    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("dav_collections")
        .set({ href: url })
        .where("id", "=", collection.id)
        .execute(),
    );
    await this.markCompleted(entry);
  }

  private async processProppatch(client: DavClient, entry: QueueEntry): Promise<void> {
    if (!entry.collection_id) {
      await this.markDead(entry, "proppatch entry carries no collection_id");
      return;
    }
    const collection = await this.db
      .selectFrom("dav_collections")
      .select(["href", "display_name", "color"])
      .where("id", "=", entry.collection_id)
      .executeTakeFirst();
    if (!collection?.href) {
      await this.markFailed(entry, "Collection has no href yet");
      return;
    }
    const result = await client.proppatch(collection.href, {
      displayName: collection.display_name,
      color: collection.color,
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
