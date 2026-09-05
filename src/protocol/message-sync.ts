import type { ImapFlow } from "imapflow";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { FlagChange } from "../sync/change-detector.js";
import { throwIfAborted } from "../util/abort.js";
import { createLogger } from "../util/logger.js";
import { sanitizeNulBytesDeep } from "../util/sanitize.js";
import { formatUidSet } from "../util/uid-set.js";
import { parseMessage } from "./mime-parser.js";
import { resolveThreadId } from "./threading.js";

const log = createLogger("message-sync");

export interface FetchAndStoreOptions {
  batchSize?: number;
  /** Marks these inserts as the initial full sync of a folder (see withSyncWriter). */
  backfill?: boolean;
  /**
   * Checked between every stored message. A large folder's fetch can run for tens of
   * seconds; without this, shutdown has nothing to interrupt until it finishes entirely.
   * Each message is stored in its own transaction, so stopping between them never leaves
   * a half-written message -- only the remaining UIDs are left for the next sync.
   */
  signal?: AbortSignal;
  /**
   * Messages larger than this are stored as envelope + flags only (`is_truncated = true`)
   * -- their body, headers and attachments are never fetched, so they're never buffered
   * in memory. Undefined means no limit; callers should pass the configured
   * `storage.max_message_bytes` (this stays optional so a direct unit/integration test of
   * this function doesn't need to invent one).
   */
  maxMessageBytes?: number;
}

const FULL_FETCH_QUERY = {
  envelope: true,
  flags: true,
  source: true,
  bodyStructure: true,
  uid: true,
  size: true,
  internalDate: true,
} as const;

const ENVELOPE_ONLY_FETCH_QUERY = {
  envelope: true,
  flags: true,
  uid: true,
  size: true,
  internalDate: true,
} as const;

/**
 * Fetch messages from IMAP by UID and store them in PG.
 * UIDs are processed in batches to avoid memory pressure.
 * Returns count of stored messages.
 */
export async function fetchAndStoreMessages(
  client: ImapFlow,
  db: Kysely<Database>,
  accountId: string,
  folderId: string,
  uids: number[],
  options: FetchAndStoreOptions = {},
): Promise<number> {
  if (uids.length === 0) return 0;

  const batchSize = options.batchSize ?? 100;
  const maxMessageBytes = options.maxMessageBytes;
  let storedCount = 0;

  for (let i = 0; i < uids.length; i += batchSize) {
    throwIfAborted(options.signal);

    const batch = uids.slice(i, i + batchSize);
    const uidRange = formatUidSet(batch);

    log.info(
      { folderId, batch: `${i + 1}-${Math.min(i + batchSize, uids.length)}/${uids.length}` },
      "Fetching message batch",
    );

    // Two-phase fetch when a size limit is configured: a message's size arrives in the
    // SAME FETCH response as its source, so there is no way to inspect it before the
    // literal is already downloaded and buffered -- a cheap size-only FETCH has to run
    // first to decide, per UID, whether the full content fetch below is safe to issue.
    let fullUids = batch;
    const oversizedUids: number[] = [];

    if (maxMessageBytes !== undefined) {
      const sizes = new Map<number, number>();
      for await (const msg of client.fetch(uidRange, { uid: true, size: true }, { uid: true })) {
        sizes.set(msg.uid, msg.size ?? 0);
      }
      fullUids = [];
      for (const uid of batch) {
        const size = sizes.get(uid);
        // A UID missing from the size probe (expunged between it and now) is dropped --
        // the next cycle's diff reports it as deleted rather than storing it twice.
        if (size === undefined) continue;
        if (size > maxMessageBytes) {
          oversizedUids.push(uid);
        } else {
          fullUids.push(uid);
        }
      }
    }

    if (fullUids.length > 0) {
      for await (const msg of client.fetch(formatUidSet(fullUids), FULL_FETCH_QUERY, {
        uid: true,
      })) {
        throwIfAborted(options.signal);
        try {
          const stored = await storeMessage(db, accountId, folderId, msg, {
            backfill: options.backfill,
            truncated: false,
          });
          if (stored) storedCount++;
        } catch (err) {
          log.error({ err, uid: msg.uid, folderId }, "Failed to store message");
        }
      }
    }

    if (oversizedUids.length > 0) {
      log.warn(
        { folderId, uids: oversizedUids, maxMessageBytes },
        "Message(s) exceed the size limit, storing envelope and flags only",
      );
      for await (const msg of client.fetch(formatUidSet(oversizedUids), ENVELOPE_ONLY_FETCH_QUERY, {
        uid: true,
      })) {
        throwIfAborted(options.signal);
        try {
          const stored = await storeMessage(db, accountId, folderId, msg, {
            backfill: options.backfill,
            truncated: true,
          });
          if (stored) storedCount++;
        } catch (err) {
          log.error({ err, uid: msg.uid, folderId }, "Failed to store message");
        }
      }
    }
  }

  log.info({ folderId, storedCount, totalUids: uids.length }, "Message fetch complete");
  return storedCount;
}

/**
 * Store a single fetched message with parsed MIME content.
 *
 * `options.truncated` messages were fetched with {@link ENVELOPE_ONLY_FETCH_QUERY} --
 * `msg.source` is never present, so `rawSource` is naturally null and MIME parsing is
 * naturally skipped below without any extra branching. `is_truncated` records the reason
 * (oversized), rather than looking indistinguishable from a MIME parse failure.
 */
async function storeMessage(
  db: Kysely<Database>,
  accountId: string,
  folderId: string,
  msg: import("imapflow").FetchMessageObject,
  options: { backfill?: boolean; truncated?: boolean } = {},
): Promise<boolean> {
  const rawSource = msg.source ?? null;
  const isTruncated = options.truncated ?? false;

  // Parse MIME content from raw source
  let parsed: Awaited<ReturnType<typeof parseMessage>> | null = null;
  if (rawSource) {
    try {
      parsed = await parseMessage(rawSource);
    } catch (err) {
      log.warn({ err, uid: msg.uid }, "MIME parse failed, storing with envelope data only");
    }
  }

  // Extract flags
  const flags = msg.flags ?? new Set<string>();
  const isSeen = flags.has("\\Seen");
  const isFlagged = flags.has("\\Flagged");
  const isAnswered = flags.has("\\Answered");
  const isDraft = flags.has("\\Draft");
  const isDeleted = flags.has("\\Deleted");

  // Extract keywords (non-system flags)
  const systemFlags = new Set([
    "\\Seen",
    "\\Flagged",
    "\\Answered",
    "\\Draft",
    "\\Deleted",
    "\\Recent",
  ]);
  const keywords = sanitizeNulBytesDeep([...flags].filter((f) => !systemFlags.has(f)));

  // Determine fields: prefer MIME-parsed data, fall back to envelope. A NUL byte in any of
  // these breaks the insert below outright -- PostgreSQL has no way to represent one in a
  // text value -- so every text-shaped field is sanitized here, at the point message
  // content becomes these variables, regardless of which path (parsed or envelope-only
  // fallback) produced it.
  const messageId = sanitizeNulBytesDeep(parsed?.messageId ?? msg.envelope?.messageId ?? null);
  const subject = sanitizeNulBytesDeep(parsed?.subject ?? msg.envelope?.subject ?? null);
  const from = sanitizeNulBytesDeep(parsed?.from ?? msg.envelope?.from?.[0]?.address ?? null);
  const toAddrs = sanitizeNulBytesDeep(parsed?.to ?? extractEnvelopeAddrs(msg.envelope?.to));
  const ccAddrs = sanitizeNulBytesDeep(parsed?.cc ?? extractEnvelopeAddrs(msg.envelope?.cc));
  const bccAddrs = sanitizeNulBytesDeep(parsed?.bcc ?? extractEnvelopeAddrs(msg.envelope?.bcc));
  const replyTo = sanitizeNulBytesDeep(
    parsed?.replyTo ?? msg.envelope?.replyTo?.[0]?.address ?? null,
  );
  const inReplyTo = sanitizeNulBytesDeep(parsed?.inReplyTo ?? msg.envelope?.inReplyTo ?? null);
  const references = sanitizeNulBytesDeep(parsed?.references ?? null);
  const bodyText = sanitizeNulBytesDeep(parsed?.bodyText ?? null);
  const bodyHtml = sanitizeNulBytesDeep(parsed?.bodyHtml ?? null);
  const rawHeaders = sanitizeNulBytesDeep(parsed?.rawHeaders ?? null);
  const receivedAt = parsed?.receivedAt ?? (msg.internalDate ? new Date(msg.internalDate) : null);

  await withSyncWriter(
    db,
    async (trx) => {
      // A re-synced message keeps its existing thread_id; only a genuinely new row gets
      // one resolved. This lookup doubles as the message row id fetch attachments need
      // below, replacing what used to be a second SELECT after the upsert.
      const existing = await trx
        .selectFrom("messages")
        .select(["id", "thread_id"])
        .where("folder_id", "=", folderId)
        .where("imap_uid", "=", String(msg.uid))
        .executeTakeFirst();

      const threadId =
        existing?.thread_id ?? (await resolveThreadId(trx, accountId, references, inReplyTo));

      // UPSERT: ON CONFLICT (folder_id, imap_uid) DO UPDATE
      const upserted = await trx
        .insertInto("messages")
        .values({
          account_id: accountId,
          folder_id: folderId,
          imap_uid: String(msg.uid),
          message_id: messageId,
          thread_id: threadId,
          subject,
          from_addr: from,
          to_addrs: toAddrs,
          cc_addrs: ccAddrs,
          bcc_addrs: bccAddrs,
          reply_to: replyTo,
          in_reply_to: inReplyTo,
          references: references,
          body_text: bodyText,
          body_html: bodyHtml,
          raw_headers: rawHeaders,
          raw_source: rawSource,
          received_at: receivedAt,
          size_bytes: msg.size ?? null,
          modseq: msg.modseq ? String(msg.modseq) : null,
          is_seen: isSeen,
          is_flagged: isFlagged,
          is_answered: isAnswered,
          is_draft: isDraft,
          is_deleted: isDeleted,
          keywords,
          expunged_at: null,
          is_truncated: isTruncated,
        })
        .onConflict((oc) =>
          oc.columns(["folder_id", "imap_uid"]).doUpdateSet({
            message_id: messageId,
            subject,
            from_addr: from,
            to_addrs: toAddrs,
            cc_addrs: ccAddrs,
            bcc_addrs: bccAddrs,
            reply_to: replyTo,
            in_reply_to: inReplyTo,
            references: references,
            body_text: bodyText,
            body_html: bodyHtml,
            raw_headers: rawHeaders,
            raw_source: rawSource,
            received_at: receivedAt,
            size_bytes: msg.size ?? null,
            modseq: msg.modseq ? String(msg.modseq) : null,
            is_seen: isSeen,
            is_flagged: isFlagged,
            is_answered: isAnswered,
            is_draft: isDraft,
            is_deleted: isDeleted,
            keywords,
            expunged_at: null,
            is_truncated: isTruncated,
          }),
        )
        .returning(["id"])
        .executeTakeFirstOrThrow();

      const messageRowId = existing?.id ?? upserted.id;

      // Store attachments if parsed. A message re-synced into truncated form (its size
      // limit lowered since the last full sync) drops whatever attachments an earlier,
      // untruncated sync stored -- they'd otherwise dangle off a row that now claims to
      // carry no attachment content.
      if (parsed?.attachments && parsed.attachments.length > 0) {
        // Delete existing attachments before re-inserting
        await trx.deleteFrom("attachments").where("message_id", "=", messageRowId).execute();

        for (const att of parsed.attachments) {
          await trx
            .insertInto("attachments")
            .values({
              message_id: messageRowId,
              filename: att.filename,
              content_type: att.contentType,
              content_id: att.contentId,
              size_bytes: att.size,
              data: att.data,
            })
            .execute();
        }
      } else if (isTruncated) {
        await trx.deleteFrom("attachments").where("message_id", "=", messageRowId).execute();
      }
    },
    { backfill: options.backfill },
  );

  return true;
}

/** Extract address strings from ImapFlow envelope address objects */
function extractEnvelopeAddrs(
  addrs: Array<{ name?: string; address?: string }> | undefined,
): string[] | null {
  if (!addrs || addrs.length === 0) return null;
  const result = addrs.filter((a) => a.address).map((a) => a.address as string);
  return result.length > 0 ? result : null;
}

/**
 * Update flags for messages that changed on the IMAP server.
 * Runs as a single sync-writer transaction so the outbound-enqueue triggers skip these
 * writes (they originate on IMAP, not from the app).
 */
export async function updateFlags(
  db: Kysely<Database>,
  folderId: string,
  flagChanges: FlagChange[],
): Promise<void> {
  if (flagChanges.length === 0) return;

  await withSyncWriter(db, async (trx) => {
    for (const change of flagChanges) {
      const isSeen = change.flags.has("\\Seen");
      const isFlagged = change.flags.has("\\Flagged");
      const isAnswered = change.flags.has("\\Answered");
      const isDraft = change.flags.has("\\Draft");
      const isDeleted = change.flags.has("\\Deleted");

      const systemFlags = new Set([
        "\\Seen",
        "\\Flagged",
        "\\Answered",
        "\\Draft",
        "\\Deleted",
        "\\Recent",
      ]);
      const keywords = [...change.flags].filter((f) => !systemFlags.has(f));

      await trx
        .updateTable("messages")
        .set({
          is_seen: isSeen,
          is_flagged: isFlagged,
          is_answered: isAnswered,
          is_draft: isDraft,
          is_deleted: isDeleted,
          keywords,
          modseq: change.modseq ? String(change.modseq) : undefined,
        })
        .where("folder_id", "=", folderId)
        .where("imap_uid", "=", String(change.uid))
        .execute();
    }
  });
}

/**
 * Mark messages as expunged (gone from the IMAP server).
 * Runs as a single sync-writer transaction, same reasoning as {@link updateFlags}.
 */
export async function expungeMessages(
  db: Kysely<Database>,
  folderId: string,
  expungedUids: number[],
): Promise<void> {
  if (expungedUids.length === 0) return;

  const uidStrings = expungedUids.map(String);

  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("messages")
      .set({ expunged_at: new Date() })
      .where("folder_id", "=", folderId)
      .where("imap_uid", "in", uidStrings)
      .where("expunged_at", "is", null)
      .execute(),
  );
}

/**
 * Hard-delete every message row for a folder (attachments cascade).
 *
 * Used exclusively on a UIDVALIDITY change: the server has renumbered UIDs, so an
 * existing row's imap_uid no longer identifies the same message. Continuing to upsert by
 * (folder_id, imap_uid) would silently rewrite an unrelated row's content -- and its id,
 * which a consumer may have foreign keys pointing at -- onto a completely different
 * email. Wiping the folder and refetching from scratch is the only way to keep row
 * identity meaning what it says.
 */
export async function resetFolderMessages(db: Kysely<Database>, folderId: string): Promise<void> {
  await withSyncWriter(db, (trx) =>
    trx.deleteFrom("messages").where("folder_id", "=", folderId).execute(),
  );
}
