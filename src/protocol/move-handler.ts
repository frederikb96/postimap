import type { ImapFlow } from "imapflow";
import type { ServerCapabilities } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("move-handler");

export interface MoveResult {
  success: boolean;
  newUid?: number;
}

export interface BatchMoveResult {
  success: boolean;
  /** Source UID -> new UID in the destination, for each UID the server actually moved. */
  uidMap: Map<number, number>;
}

/**
 * Move any number of messages to a target folder via IMAP in a single command.
 *
 * Uses RFC 6851 MOVE if available (atomic, server-side).
 * Falls back to COPY + delete for servers without MOVE support.
 *
 * A UID absent from the source folder is not an IMAP error -- the server silently
 * ignores it -- so `uidMap` is the only way to tell which of the requested UIDs actually
 * moved. The caller resolves the rest individually (a message another actor already
 * moved, or one that no longer exists at all).
 */
export async function moveMessages(
  client: ImapFlow,
  uids: number[],
  targetFolder: string,
  capabilities: ServerCapabilities,
): Promise<BatchMoveResult> {
  if (capabilities.move) {
    const result = await client.messageMove(uids, targetFolder, { uid: true });
    if (result === false) {
      log.warn({ uids, targetFolder }, "MOVE returned false (message range may not exist)");
      return { success: false, uidMap: new Map() };
    }

    return { success: true, uidMap: result.uidMap ?? new Map() };
  }

  // Fallback: COPY + DELETE
  const copyResult = await client.messageCopy(uids, targetFolder, { uid: true });
  if (copyResult === false) {
    log.warn({ uids, targetFolder }, "COPY returned false (message range may not exist)");
    return { success: false, uidMap: new Map() };
  }

  const uidMap = copyResult.uidMap ?? new Map();

  try {
    await client.messageDelete(uids, { uid: true });
  } catch (err) {
    // COPY succeeded but DELETE failed: messages exist in both folders temporarily.
    // Inbound sync will clean up on the next cycle.
    log.warn(
      { err, uids, targetFolder },
      "COPY succeeded but DELETE failed; inbound sync will resolve",
    );
  }

  return { success: true, uidMap };
}

/** Move a single message. Thin wrapper over `moveMessages` for the one-message case. */
export async function moveMessage(
  client: ImapFlow,
  uid: number,
  targetFolder: string,
  capabilities: ServerCapabilities,
): Promise<MoveResult> {
  const result = await moveMessages(client, [uid], targetFolder, capabilities);
  return { success: result.success, newUid: result.uidMap.get(uid) };
}
