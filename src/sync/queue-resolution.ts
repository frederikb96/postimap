import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("queue-resolution");

/**
 * The parts of a sync_queue row needed to work out what it acts on.
 *
 * `folder_id` is the queue row's own value falling back to the message's current folder,
 * and `imap_uid` is the message's UID as it is NOW -- not as the batch claim saw it.
 */
export interface ResolvableEntry {
  action: string;
  payload: Record<string, unknown>;
  folder_id: string | null;
  imap_uid: string | null;
}

/** Where an operation acts, and on which UID. */
export type ResolvedTarget =
  | {
      resolved: true;
      /** The folder the message physically is in -- SELECT this before naming the UID. */
      sourceFolderId: string;
      /** The UID naming the message in that folder. */
      sourceUid: number;
      /** Move only: where the message should end up. Null for every other action. */
      targetFolderId: string | null;
    }
  | { resolved: false; unresolved: string };

interface QueuePayload {
  folder_id?: string;
  imap_uid?: string | null;
  from_folder_id?: string;
  to_folder_id?: string;
  old_imap_uid?: string | null;
}

function toUid(value: string | null | undefined): number | null {
  return value == null ? null : Number(value);
}

/**
 * Work out what a queue entry acts on: live state first, then the entry's own payload,
 * then an explicit reason for giving up.
 *
 * Every branch of outbound processing goes through this, because each of the four bugs in
 * this family came from one branch resolving state its own way and assuming a value
 * captured at enqueue time still meant what it meant then. An optimistic move nulls
 * `messages.imap_uid` before PostIMAP has ever seen the operation, so both sources are
 * incomplete on their own: the payload holds the pre-move UID the live row no longer has,
 * and the live row holds the post-move UID that a payload captured after the nulling
 * never got.
 */
export function resolveTarget(entry: ResolvableEntry): ResolvedTarget {
  const payload = entry.payload as QueuePayload;
  const liveUid = toUid(entry.imap_uid);

  switch (entry.action) {
    case "move": {
      // A move's own coordinates never come from the row: `folder_id` there is already
      // the destination the app wrote, and `imap_uid` is the NULL it wrote with it.
      const sourceFolderId = payload.from_folder_id ?? null;
      const targetFolderId = payload.to_folder_id ?? null;
      // The payload UID is missing only when the trigger fired on an already-nulled row
      // -- a move chain whose earlier hops were claimed in a different batch. The live
      // column is then the UID the hop that actually landed the message in
      // `from_folder_id` wrote back, which is exactly the one to move from.
      const sourceUid = toUid(payload.old_imap_uid) ?? liveUid;

      const missing = describeMissing([
        [sourceFolderId === null, "source folder"],
        [targetFolderId === null, "target folder"],
        [sourceUid === null, "source imap_uid"],
      ]);
      if (missing || sourceFolderId === null || sourceUid === null) {
        return { resolved: false, unresolved: missing ?? "Cannot resolve move coordinates" };
      }
      return { resolved: true, sourceFolderId, sourceUid, targetFolderId };
    }

    case "delete": {
      // A delete that superseded a move carries the move's source coordinates; a plain
      // one carries the folder the expunge trigger captured.
      const sourceFolderId = payload.folder_id ?? entry.folder_id ?? null;
      const sourceUid = toUid(payload.imap_uid) ?? liveUid;

      const missing = describeMissing([
        [sourceFolderId === null, "folder"],
        [sourceUid === null, "imap_uid"],
      ]);
      if (missing || sourceFolderId === null || sourceUid === null) {
        return { resolved: false, unresolved: missing ?? "Cannot resolve delete coordinates" };
      }
      return { resolved: true, sourceFolderId, sourceUid, targetFolderId: null };
    }

    default: {
      // flag_add / flag_remove act where the message is now, on the UID it has now.
      const sourceFolderId = entry.folder_id ?? payload.folder_id ?? null;

      const missing = describeMissing([
        [sourceFolderId === null, "folder"],
        [liveUid === null, "imap_uid"],
      ]);
      if (missing || sourceFolderId === null || liveUid === null) {
        return { resolved: false, unresolved: missing ?? "Cannot resolve flag coordinates" };
      }
      return { resolved: true, sourceFolderId, sourceUid: liveUid, targetFolderId: null };
    }
  }
}

function describeMissing(checks: [boolean, string][]): string | null {
  const missing = checks.filter(([failed]) => failed).map(([, name]) => name);
  return missing.length === 0 ? null : `Cannot resolve ${missing.join(" and ")}`;
}

/**
 * Give up on every queued operation whose source UID belongs to a folder the server has
 * renumbered.
 *
 * A UIDVALIDITY change means the server reassigned UIDs, so a UID captured before it can
 * now name a different message entirely -- applying a queued flag, move or delete would
 * silently act on mail the user never touched. RFC 3501 requires a client to discard
 * cached UIDs across that boundary, and a queued operation is a cached UID with an
 * instruction attached.
 *
 * Entries moving a message *into* the renumbered folder are left alone: their source UID
 * lives in another folder and is unaffected.
 *
 * Dead-lettering rather than deleting is deliberate -- it is the terminal state that
 * fires `sync_error` on `postimap_events`, so the consumer learns its write never landed
 * instead of the operation disappearing silently.
 */
export async function invalidateFolderQueue(
  db: Kysely<Database>,
  folderId: string,
): Promise<number> {
  const error = "Folder UIDVALIDITY changed; captured imap_uid no longer identifies a message";

  const result = await withSyncWriter(db, (trx) =>
    sql<{ id: string }>`
      UPDATE sync_queue sq
      SET status = 'dead',
          attempts = sq.attempts + 1,
          error = ${error},
          processed_at = now()
      FROM messages m
      WHERE sq.message_id = m.id
        AND sq.status IN ('pending', 'failed', 'processing')
        AND CASE sq.action
              WHEN 'move' THEN sq.payload->>'from_folder_id' = ${folderId}
              WHEN 'delete' THEN COALESCE(sq.payload->>'folder_id', m.folder_id::text) = ${folderId}
              ELSE COALESCE(sq.folder_id::text, m.folder_id::text) = ${folderId}
            END
      RETURNING sq.id
    `.execute(trx),
  );

  const count = result.rows.length;
  if (count > 0) {
    log.warn({ folderId, count }, "Dead-lettered queued operations on a renumbered folder");
  }
  return count;
}
