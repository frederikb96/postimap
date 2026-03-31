import type { ImapFlow, StoreOptions } from "imapflow";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("flag-sync");

export interface FlagSyncResult {
  success: boolean;
  conflict: boolean;
}

/**
 * Sync a single flag change to IMAP with optional CONDSTORE optimistic locking.
 *
 * When CONDSTORE is available and currentModseq is provided, uses UNCHANGEDSINCE
 * to detect concurrent modifications. If the server returns MODIFIED (the message
 * changed since our known modseq), we return conflict=true so the caller can let
 * the next inbound sync resolve the state.
 */
export async function syncFlagToImap(
  client: ImapFlow,
  uid: number,
  action: "flag_add" | "flag_remove",
  flag: string,
  capabilities: ServerCapabilities,
  currentModseq?: bigint,
): Promise<FlagSyncResult> {
  const opts: StoreOptions = { uid: true, silent: true };

  if (capabilities.condstore && currentModseq != null && currentModseq > 0n) {
    opts.unchangedSince = currentModseq;
  }

  try {
    const applied =
      action === "flag_add"
        ? await client.messageFlagsAdd(String(uid), [flag], opts)
        : await client.messageFlagsRemove(String(uid), [flag], opts);

    // ImapFlow returns false when UNCHANGEDSINCE fails (MODIFIED response)
    if (!applied && opts.unchangedSince != null) {
      log.info(
        { uid, action, flag, modseq: currentModseq?.toString() },
        "CONDSTORE conflict: message modified since our modseq",
      );
      return { success: false, conflict: true };
    }

    return { success: true, conflict: false };
  } catch (err) {
    // Check for MODIFIED response in error message
    if (err instanceof Error && err.message.includes("MODIFIED")) {
      log.info(
        { uid, action, flag, modseq: currentModseq?.toString() },
        "CONDSTORE conflict detected via error",
      );
      return { success: false, conflict: true };
    }
    throw err;
  }
}
