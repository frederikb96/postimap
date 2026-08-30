import type { ImapFlow } from "imapflow";
import { createLogger } from "../util/logger.js";

const log = createLogger("folder-ops");

export interface FolderOpResult {
  success: boolean;
  /** Set when the operation cannot succeed however often it is retried. */
  permanentError?: string;
}

/**
 * INBOX is required to exist and cannot be deleted (RFC 3501). A consumer that
 * tombstones it would otherwise queue an operation that fails identically on every
 * attempt until it dead-letters.
 */
function isInbox(path: string): boolean {
  return path.toUpperCase() === "INBOX";
}

/**
 * Create a mailbox on the server.
 *
 * A name that already exists is success, not failure: the desired state is a mailbox
 * under that name, and a folder the consumer created between two sync cycles can
 * legitimately be mirrored before its own queue entry is processed.
 */
export async function createFolder(client: ImapFlow, path: string): Promise<FolderOpResult> {
  try {
    await client.mailboxCreate(path);
    return { success: true };
  } catch (err) {
    if (isAlreadyExists(err)) {
      log.info({ path }, "Mailbox already exists, treating create as satisfied");
      return { success: true };
    }
    throw err;
  }
}

/**
 * Delete a mailbox from the server, destroying every message in it.
 *
 * A name that is already absent is success for the same reason a create onto an existing
 * name is: the row is a request for a state, not for a command to have run.
 */
export async function deleteFolder(client: ImapFlow, path: string): Promise<FolderOpResult> {
  if (isInbox(path)) {
    return { success: false, permanentError: "INBOX cannot be deleted" };
  }

  try {
    await client.mailboxDelete(path);
    return { success: true };
  } catch (err) {
    if (isNonExistent(err)) {
      log.info({ path }, "Mailbox already absent, treating delete as satisfied");
      return { success: true };
    }
    throw err;
  }
}

/**
 * Servers disagree on how they refuse a duplicate CREATE -- Dovecot answers
 * `NO [ALREADYEXISTS]`, others only a bare text. Match the response code where there is
 * one and the wording otherwise, since the alternative is retrying a state that is
 * already correct until it dead-letters.
 */
function isAlreadyExists(err: unknown): boolean {
  const text = errorText(err);
  return text.includes("alreadyexists") || text.includes("already exists");
}

function isNonExistent(err: unknown): boolean {
  const text = errorText(err);
  return (
    text.includes("nonexistent") ||
    text.includes("does not exist") ||
    text.includes("no such mailbox")
  );
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  const code = (err as { responseText?: string; serverResponseCode?: string })?.serverResponseCode;
  if (code) parts.push(code);
  const responseText = (err as { responseText?: string })?.responseText;
  if (responseText) parts.push(responseText);
  return parts.join(" ").toLowerCase();
}
