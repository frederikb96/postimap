import type { ImapFlow } from "imapflow";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { FlagChange } from "../sync/change-detector.js";
import { createLogger } from "../util/logger.js";
import { formatUidSet } from "../util/uid-set.js";
import { parseMessage } from "./mime-parser.js";

const log = createLogger("message-sync");

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
  batchSize = 100,
): Promise<number> {
  if (uids.length === 0) return 0;

  let storedCount = 0;

  for (let i = 0; i < uids.length; i += batchSize) {
    const batch = uids.slice(i, i + batchSize);
    const uidRange = formatUidSet(batch);

    log.info(
      { folderId, batch: `${i + 1}-${Math.min(i + batchSize, uids.length)}/${uids.length}` },
      "Fetching message batch",
    );

    for await (const msg of client.fetch(
      uidRange,
      {
        envelope: true,
        flags: true,
        source: true,
        bodyStructure: true,
        uid: true,
        size: true,
        internalDate: true,
      },
      { uid: true },
    )) {
      try {
        const stored = await storeMessage(db, accountId, folderId, msg);
        if (stored) storedCount++;
      } catch (err) {
        log.error({ err, uid: msg.uid, folderId }, "Failed to store message");
      }
    }
  }

  log.info({ folderId, storedCount, totalUids: uids.length }, "Message fetch complete");
  return storedCount;
}

/** Store a single fetched message with parsed MIME content */
async function storeMessage(
  db: Kysely<Database>,
  accountId: string,
  folderId: string,
  msg: import("imapflow").FetchMessageObject,
): Promise<boolean> {
  const rawSource = msg.source ?? null;

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
  const keywords = [...flags].filter((f) => !systemFlags.has(f));

  // Determine fields: prefer MIME-parsed data, fall back to envelope
  const messageId = parsed?.messageId ?? msg.envelope?.messageId ?? null;
  const subject = parsed?.subject ?? msg.envelope?.subject ?? null;
  const from = parsed?.from ?? msg.envelope?.from?.[0]?.address ?? null;
  const toAddrs = parsed?.to ?? extractEnvelopeAddrs(msg.envelope?.to);
  const ccAddrs = parsed?.cc ?? extractEnvelopeAddrs(msg.envelope?.cc);
  const bccAddrs = parsed?.bcc ?? extractEnvelopeAddrs(msg.envelope?.bcc);
  const replyTo = parsed?.replyTo ?? msg.envelope?.replyTo?.[0]?.address ?? null;
  const inReplyTo = parsed?.inReplyTo ?? msg.envelope?.inReplyTo ?? null;
  const references = parsed?.references ?? null;
  const bodyText = parsed?.bodyText ?? null;
  const bodyHtml = parsed?.bodyHtml ?? null;
  const rawHeaders = parsed?.rawHeaders ? JSON.stringify(parsed.rawHeaders) : null;
  const receivedAt = parsed?.receivedAt ?? (msg.internalDate ? new Date(msg.internalDate) : null);

  // UPSERT: ON CONFLICT (folder_id, imap_uid) DO UPDATE
  await db
    .insertInto("messages")
    .values({
      account_id: accountId,
      folder_id: folderId,
      imap_uid: String(msg.uid),
      message_id: messageId,
      subject,
      from_addr: from,
      to_addrs: toAddrs ? JSON.stringify(toAddrs) : null,
      cc_addrs: ccAddrs ? JSON.stringify(ccAddrs) : null,
      bcc_addrs: bccAddrs ? JSON.stringify(bccAddrs) : null,
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
      sync_version: sql`1`,
      deleted_at: null,
    })
    .onConflict((oc) =>
      oc.columns(["folder_id", "imap_uid"]).doUpdateSet({
        message_id: messageId,
        subject,
        from_addr: from,
        to_addrs: toAddrs ? JSON.stringify(toAddrs) : null,
        cc_addrs: ccAddrs ? JSON.stringify(ccAddrs) : null,
        bcc_addrs: bccAddrs ? JSON.stringify(bccAddrs) : null,
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
        sync_version: sql`messages.sync_version + 1`,
        deleted_at: null,
      }),
    )
    .execute();

  // Store attachments if parsed
  if (parsed?.attachments && parsed.attachments.length > 0) {
    // Get the message row ID for FK
    const msgRow = await db
      .selectFrom("messages")
      .select("id")
      .where("folder_id", "=", folderId)
      .where("imap_uid", "=", String(msg.uid))
      .executeTakeFirst();

    if (msgRow) {
      // Delete existing attachments before re-inserting
      await db.deleteFrom("attachments").where("message_id", "=", msgRow.id).execute();

      for (const att of parsed.attachments) {
        await db
          .insertInto("attachments")
          .values({
            message_id: msgRow.id,
            filename: att.filename,
            content_type: att.contentType,
            content_id: att.contentId,
            size_bytes: att.size,
            data: att.data,
          })
          .execute();
      }
    }
  }

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
 * Each flag change increments sync_version to prevent outbound re-sync.
 */
export async function updateFlags(
  db: Kysely<Database>,
  folderId: string,
  flagChanges: FlagChange[],
): Promise<void> {
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

    await db
      .updateTable("messages")
      .set({
        is_seen: isSeen,
        is_flagged: isFlagged,
        is_answered: isAnswered,
        is_draft: isDraft,
        is_deleted: isDeleted,
        keywords,
        modseq: change.modseq ? String(change.modseq) : undefined,
        sync_version: sql`messages.sync_version + 1`,
      })
      .where("folder_id", "=", folderId)
      .where("imap_uid", "=", String(change.uid))
      .execute();
  }
}

/**
 * Soft-delete messages that were removed from the IMAP server.
 * Sets deleted_at and increments sync_version.
 */
export async function softDeleteMessages(
  db: Kysely<Database>,
  folderId: string,
  deletedUids: number[],
): Promise<void> {
  if (deletedUids.length === 0) return;

  const uidStrings = deletedUids.map(String);

  await db
    .updateTable("messages")
    .set({
      deleted_at: new Date(),
      sync_version: sql`messages.sync_version + 1`,
    })
    .where("folder_id", "=", folderId)
    .where("imap_uid", "in", uidStrings)
    .where("deleted_at", "is", null)
    .execute();
}
