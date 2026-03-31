import type { ImapFlow } from "imapflow";
import { createLogger } from "../util/logger.js";

const log = createLogger("delete-handler");

export interface DeleteResult {
  success: boolean;
}

/**
 * Delete a message on IMAP (STORE \Deleted + EXPUNGE).
 * ImapFlow's messageDelete handles both steps.
 */
export async function deleteMessage(client: ImapFlow, uid: number): Promise<DeleteResult> {
  const result = await client.messageDelete(String(uid), { uid: true });

  if (!result) {
    log.warn({ uid }, "messageDelete returned false (message may not exist or already deleted)");
    // Treat as success: if the message doesn't exist, the desired state is achieved
    return { success: true };
  }

  return { success: true };
}
