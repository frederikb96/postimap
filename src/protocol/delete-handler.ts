import type { ImapFlow } from "imapflow";
import { createLogger } from "../util/logger.js";

const log = createLogger("delete-handler");

export interface DeleteResult {
  success: boolean;
}

/**
 * Delete any number of messages on IMAP (STORE \Deleted + EXPUNGE) in a single command.
 * ImapFlow's messageDelete handles both steps.
 *
 * A UID absent from the folder is not an IMAP error -- the server silently ignores it --
 * so this always reports success: if a message doesn't exist, the desired state (gone)
 * is already achieved, for every UID in the range alike.
 */
export async function deleteMessages(client: ImapFlow, uids: number[]): Promise<DeleteResult> {
  const result = await client.messageDelete(uids, { uid: true });

  if (!result) {
    log.warn({ uids }, "messageDelete returned false (messages may not exist or already deleted)");
  }

  return { success: true };
}

/** Delete a single message. Thin wrapper over `deleteMessages` for the one-message case. */
export async function deleteMessage(client: ImapFlow, uid: number): Promise<DeleteResult> {
  return deleteMessages(client, [uid]);
}
