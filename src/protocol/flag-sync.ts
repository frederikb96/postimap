import type { ImapFlow, StoreOptions } from "imapflow";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("flag-sync");

export interface FlagSyncResult {
  success: boolean;
  conflict: boolean;
}

export interface BatchFlagSyncResult {
  success: boolean;
}

/**
 * Apply the same flag change to many messages in one STORE command.
 *
 * No UNCHANGEDSINCE: CONDSTORE optimistic locking is inherently per-message, and a batch
 * spans messages that each have their own modseq -- there is no single threshold that
 * means the same thing for all of them. The caller uses this only when more than one
 * message shares the same (folder, action, flag) grouping; a lone message still goes
 * through `syncFlagToImap` and keeps its per-message conflict detection.
 */
export async function syncFlagsToImapBatch(
  client: ImapFlow,
  uids: number[],
  action: "flag_add" | "flag_remove",
  flag: string,
): Promise<BatchFlagSyncResult> {
  const opts: StoreOptions = { uid: true, silent: true };

  const applied =
    action === "flag_add"
      ? await client.messageFlagsAdd(uids, [flag], opts)
      : await client.messageFlagsRemove(uids, [flag], opts);

  return { success: applied };
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
