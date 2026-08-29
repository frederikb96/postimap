import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";

/**
 * Resolve the thread_id for a newly-inserted message.
 *
 * Candidates are every id in `references` (RFC 5256's ordering is oldest-first, so the
 * closest ancestor -- the immediate parent -- is the last entry) plus `in_reply_to`,
 * looked up together against `(account_id, message_id)`. A single matching thread is
 * used as-is; no match starts a new thread. If the candidates span more than one
 * existing thread (this message cross-references two previously-unrelated
 * conversations), every message on the newer thread is remapped onto the older one so
 * the whole conversation ends up under a single thread_id.
 *
 * Deliberately does not fall back to subject matching -- RFC 5256's References/In-Reply-To
 * resolution covers the overwhelming majority of real threads at a fraction of the
 * complexity of full subject-normalization heuristics. See docs/consumer-contract.md.
 */
export async function resolveThreadId(
  trx: Kysely<Database>,
  accountId: string,
  references: string[] | null,
  inReplyTo: string | null,
): Promise<string> {
  const candidates: string[] = [];
  if (references) {
    for (let i = references.length - 1; i >= 0; i--) {
      candidates.push(references[i]);
    }
  }
  if (inReplyTo) candidates.push(inReplyTo);

  const dedup = [...new Set(candidates)];
  if (dedup.length === 0) return randomUUID();

  const matches = await trx
    .selectFrom("messages")
    .select("thread_id")
    .distinct()
    .where("account_id", "=", accountId)
    .where("message_id", "in", dedup)
    .execute();

  const threadIds = [...new Set(matches.map((m) => m.thread_id))];
  if (threadIds.length === 0) return randomUUID();
  if (threadIds.length === 1) return threadIds[0];

  // Bridges multiple existing threads: adopt the oldest (by its earliest message),
  // remap every message currently on the other thread_ids onto it.
  const ages = await trx
    .selectFrom("messages")
    .select(["thread_id", (eb) => eb.fn.min("created_at").as("oldest")])
    .where("account_id", "=", accountId)
    .where("thread_id", "in", threadIds)
    .groupBy("thread_id")
    .execute();

  ages.sort((a, b) => a.oldest.getTime() - b.oldest.getTime());
  const canonical = ages[0].thread_id;
  const rest = threadIds.filter((t) => t !== canonical);

  if (rest.length > 0) {
    await trx
      .updateTable("messages")
      .set({ thread_id: canonical })
      .where("account_id", "=", accountId)
      .where("thread_id", "in", rest)
      .execute();
  }

  return canonical;
}
