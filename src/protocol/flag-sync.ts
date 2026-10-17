import type { ImapFlow, StoreOptions } from "imapflow";

export interface FlagSyncResult {
  success: boolean;
}

/**
 * Apply the same flag change to one or many messages in one STORE command.
 *
 * No UNCHANGEDSINCE: +FLAGS/-FLAGS of a single flag commutes with a concurrent change to any
 * other flag, and a concurrent change to the same flag ends in the same state, so the guard
 * could only throw changes away. ImapFlow also reports a store the server refused with
 * MODIFIED as a success, so such a refusal would go unnoticed.
 */
export async function syncFlagsToImap(
  client: ImapFlow,
  uids: number[],
  action: "flag_add" | "flag_remove",
  flag: string,
): Promise<FlagSyncResult> {
  const opts: StoreOptions = { uid: true, silent: true };

  const applied =
    action === "flag_add"
      ? await client.messageFlagsAdd(uids, [flag], opts)
      : await client.messageFlagsRemove(uids, [flag], opts);

  return { success: applied };
}
