import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.js";

/**
 * Retrieve UIDs that have pending, processing or failed outbound sync_queue entries.
 * These UIDs should be excluded from inbound flag comparison to prevent
 * the outbound processor's IMAP writes from being re-imported.
 *
 * `failed` is included alongside `pending`/`processing`: a flag write awaiting its next
 * retry is still an outbound write in flight, not a settled one, and excluding only the
 * first two lets an inbound cycle read the pre-write flag as a change, overwrite the
 * still-queued value, and have the eventual retry re-apply it -- flicker with no write
 * ever actually lost, but visible to anyone watching the flag.
 */
export async function getPendingOutboundUids(
  db: Kysely<Database>,
  accountId: string,
  folderId: string,
): Promise<Set<number>> {
  const rows = await db
    .selectFrom("messages as m")
    .innerJoin("sync_queue as sq", "sq.message_id", "m.id")
    .select("m.imap_uid")
    .where("m.account_id", "=", accountId)
    .where("m.folder_id", "=", folderId)
    .where("sq.status", "in", ["pending", "processing", "failed"])
    // A pending optimistic move has no imap_uid yet -- nothing to exclude from the
    // remote UID comparison until PostIMAP writes the real one back.
    .where("m.imap_uid", "is not", null)
    .execute();

  return new Set(rows.map((r) => Number(r.imap_uid)));
}

/**
 * UIDs this folder should still be treated as holding, even though the mirrored row's
 * own state (`folder_id`, `imap_uid`, `expunged_at`) no longer says so, because an
 * outbound write for it is still queued and the server hasn't been told yet:
 *
 * - a message this folder's expunge trigger enqueued a `delete` for -- `expunged_at` is
 *   already set, but the row (and its `imap_uid`) is untouched otherwise, since only a
 *   move nulls that column
 * - a message an optimistic move is carrying OUT of this folder -- its row now lives
 *   under the destination `folder_id` with `imap_uid` NULL, so this folder's own rows
 *   no longer mention it at all; the source UID comes from the move's payload
 *
 * Both cases describe a message the server still has, under the UID it always had, for
 * as long as the queue entry sits unresolved. Treating it as merely "gone from PG's
 * knowledge of this folder" -- what a plain `folder_id`/`expunged_at` read does -- makes
 * a fresh remote diff see an ordinary UID with nothing local to match: a pending delete's
 * target comes back as a new insert with `expunged_at` cleared, undoing the app's write,
 * and a pending move's source is inserted a second time under the folder it already left.
 */
export async function getQueuedFolderUids(
  db: Kysely<Database>,
  accountId: string,
  folderId: string,
): Promise<Set<number>> {
  const rows = await sql<{ uid: string | null }>`
    SELECT
      CASE sq.action
        WHEN 'move' THEN COALESCE((sq.payload->>'old_imap_uid')::bigint, m.imap_uid::bigint)
        WHEN 'delete' THEN COALESCE((sq.payload->>'imap_uid')::bigint, m.imap_uid::bigint)
      END::text AS uid
    FROM sync_queue sq
    JOIN messages m ON m.id = sq.message_id
    WHERE sq.account_id = ${accountId}
      AND sq.status IN ('pending', 'processing', 'failed')
      AND sq.action IN ('move', 'delete')
      AND CASE sq.action
            WHEN 'move' THEN sq.payload->>'from_folder_id' = ${folderId}
            WHEN 'delete' THEN COALESCE(sq.payload->>'folder_id', m.folder_id::text) = ${folderId}
          END
  `.execute(db);

  const uids = new Set<number>();
  for (const row of rows.rows) {
    if (row.uid !== null) uids.add(Number(row.uid));
  }
  return uids;
}
