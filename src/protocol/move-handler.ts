import type { ImapFlow } from "imapflow";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("move-handler");

export interface MoveResult {
  success: boolean;
  newUid?: number;
}

/**
 * Move a message to a target folder via IMAP.
 *
 * Uses RFC 6851 MOVE if available (atomic, server-side).
 * Falls back to COPY + delete for servers without MOVE support.
 */
export async function moveMessage(
  client: ImapFlow,
  uid: number,
  targetFolder: string,
  capabilities: ServerCapabilities,
): Promise<MoveResult> {
  if (capabilities.move) {
    const result = await client.messageMove(String(uid), targetFolder, { uid: true });
    if (result === false) {
      log.warn({ uid, targetFolder }, "MOVE returned false (message may not exist)");
      return { success: false };
    }

    const newUid = result.uidMap?.values().next().value;
    return { success: true, newUid };
  }

  // Fallback: COPY + DELETE
  const copyResult = await client.messageCopy(String(uid), targetFolder, { uid: true });
  if (copyResult === false) {
    log.warn({ uid, targetFolder }, "COPY returned false (message may not exist)");
    return { success: false };
  }

  const newUid = copyResult.uidMap?.values().next().value;

  try {
    await client.messageDelete(String(uid), { uid: true });
  } catch (err) {
    // COPY succeeded but DELETE failed: message exists in both folders temporarily.
    // Inbound sync will clean up on the next cycle.
    log.warn(
      { err, uid, targetFolder },
      "COPY succeeded but DELETE failed; inbound sync will resolve",
    );
  }

  return { success: true, newUid };
}
