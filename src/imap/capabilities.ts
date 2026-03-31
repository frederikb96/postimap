import type { ImapFlow } from "imapflow";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";

export interface ServerCapabilities {
  condstore: boolean;
  qresync: boolean;
  idle: boolean;
  move: boolean;
  uidplus: boolean;
  mailboxId: boolean;
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
  if (caps.qresync) return "qresync";
  if (caps.condstore) return "condstore";
  return "full";
}

/** Store detected capabilities in the accounts table */
export async function cacheCapabilities(
  db: Kysely<Database>,
  accountId: string,
  caps: ServerCapabilities,
): Promise<void> {
  await db
    .updateTable("accounts")
    .set({ capabilities: JSON.stringify(caps), updated_at: new Date() })
    .where("id", "=", accountId)
    .execute();
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

  const raw =
    typeof row.capabilities === "string" ? JSON.parse(row.capabilities) : row.capabilities;

  return raw as ServerCapabilities;
}
