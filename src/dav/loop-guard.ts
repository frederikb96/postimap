import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.js";

/**
 * Every server href an account's pending outbound work still refers to: the object's
 * current href, the source href a queued move captured, the href a queued delete
 * captured. Inbound reconciliation leaves these alone -- between the consumer's write and
 * the queue draining, PG and the server are meant to disagree, and both directions of
 * that disagreement look exactly like an ordinary server-side change. A pending move
 * would be re-imported at its source and tombstoned at its destination; a pending edit
 * would be overwritten and then lose its If-Match conflict check.
 */
export async function getPendingHrefs(
  db: Kysely<Database>,
  accountId: string,
): Promise<Set<string>> {
  const rows = await sql<{
    object_href: string | null;
    old_href: string | null;
    href: string | null;
  }>`
    SELECT o.href AS object_href, q.payload->>'old_href' AS old_href, q.payload->>'href' AS href
    FROM dav_sync_queue q
    LEFT JOIN dav_objects o ON o.id = q.object_id
    WHERE q.account_id = ${accountId}
      AND q.object_id IS NOT NULL
      AND q.status IN ('pending', 'processing', 'failed')
  `.execute(db);

  const hrefs = new Set<string>();
  for (const row of rows.rows) {
    for (const href of [row.object_href, row.old_href, row.href]) {
      if (href) hrefs.add(href);
    }
  }
  return hrefs;
}

/** Collections with a queued PROPPATCH, whose properties reconciliation must not refresh. */
export async function getPendingPropCollections(
  db: Kysely<Database>,
  accountId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("dav_sync_queue")
    .select("collection_id")
    .where("account_id", "=", accountId)
    .where("action", "=", "proppatch")
    .where("status", "in", ["pending", "processing", "failed"])
    .where("collection_id", "is not", null)
    .execute();
  return new Set(rows.map((r) => r.collection_id as string));
}
