import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";

/**
 * Retrieve UIDs that have pending or processing outbound sync_queue entries.
 * These UIDs should be excluded from inbound flag comparison to prevent
 * the outbound processor's IMAP writes from being re-imported.
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
    .where("sq.status", "in", ["pending", "processing"])
    .execute();

  return new Set(rows.map((r) => Number(r.imap_uid)));
}
