import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * `DELETE` on `accounts` for `postimap_app`. Without it a consumer can add an account and
 * disable it but never remove it, so a mailbox added by mistake keeps its folders,
 * messages and attachments forever.
 *
 * The grant is on `accounts` alone: every child table already declares
 * `ON DELETE CASCADE` against it, so removing the account row tears down folders,
 * messages, attachments, sync_queue, sync_state, sync_audit and outbox with it, and no
 * other table needs a delete grant to make that work.
 *
 * A `postimap_commands` action would let the sync engine sequence its own teardown first,
 * but that channel is fire-and-forget: a delete requested while the service is restarting
 * is lost and the account silently survives. A DELETE is durable and transactional
 * instead, and the orchestrator already stops an account whose row has disappeared.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`GRANT DELETE ON accounts TO postimap_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE DELETE ON accounts FROM postimap_app`.execute(db);
}
