import type { ImapFlow } from "imapflow";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";

export interface ServerCapabilities {
  condstore: boolean;
  qresync: boolean;
  idle: boolean;
  move: boolean;
  uidplus: boolean;
  mailboxId: boolean;
  /**
   * Set once a CHANGEDSINCE fetch has been observed not to actually filter -- a server
   * that advertises and enables CONDSTORE (Zoho among them) but ignores CHANGEDSINCE and
   * omits MODSEQ from its FETCH responses entirely, which RFC 7162 requires once CONDSTORE
   * is enabled on a mailbox that isn't NOMODSEQ. Unlike the other fields, the server's own
   * CAPABILITY list can never say this -- it keeps claiming CONDSTORE support -- so this
   * one has to be carried forward across every later re-detection; see
   * `markCondstoreUnreliable`.
   */
  condstoreUnreliable?: boolean;
}

export type SyncTier = "qresync" | "condstore" | "full";

/** Read capabilities from a connected ImapFlow client */
export function detectCapabilities(client: ImapFlow): ServerCapabilities {
  const caps = client.capabilities;
  return {
    condstore: caps.has("CONDSTORE"),
    qresync: caps.has("QRESYNC"),
    idle: caps.has("IDLE"),
    move: caps.has("MOVE"),
    uidplus: caps.has("UIDPLUS"),
    mailboxId: caps.has("OBJECTID"),
  };
}

/** Select the best sync tier based on detected capabilities */
export function selectSyncTier(caps: ServerCapabilities): SyncTier {
  // Checked ahead of (and independently of) condstore/qresync so this holds even if a
  // caller ever sets the marker without going through markCondstoreUnreliable.
  if (caps.condstoreUnreliable) return "full";
  if (caps.qresync) return "qresync";
  if (caps.condstore) return "condstore";
  return "full";
}

/**
 * Downgrades a capabilities object in place once CHANGEDSINCE has been caught not
 * actually filtering (see `ServerCapabilities.condstoreUnreliable`). Forces `condstore`
 * and `qresync` off so `selectSyncTier` picks "full" from here on, and every other place
 * that reads either field directly (`flag-sync.ts`'s outbound UNCHANGEDSINCE guard) sees
 * an honest answer too. The caller is responsible for persisting the result via
 * `cacheCapabilities` so it survives a restart, and for re-applying it onto a freshly
 * `detectCapabilities()`-derived object afterwards -- the server's advertised CAPABILITY
 * list will keep claiming CONDSTORE support regardless.
 */
export function markCondstoreUnreliable(caps: ServerCapabilities): void {
  caps.condstoreUnreliable = true;
  caps.condstore = false;
  caps.qresync = false;
}

/** Store detected capabilities in the accounts table */
export async function cacheCapabilities(
  db: Kysely<Database>,
  accountId: string,
  caps: ServerCapabilities,
): Promise<void> {
  await withSyncWriter(db, (trx) =>
    trx.updateTable("accounts").set({ capabilities: caps }).where("id", "=", accountId).execute(),
  );
}

/** Retrieve cached capabilities from the accounts table */
export async function getCachedCapabilities(
  db: Kysely<Database>,
  accountId: string,
): Promise<ServerCapabilities | null> {
  const row = await db
    .selectFrom("accounts")
    .select("capabilities")
    .where("id", "=", accountId)
    .executeTakeFirst();

  if (!row?.capabilities) return null;

  return row.capabilities as ServerCapabilities;
}
