import type { ImapFlow } from "imapflow";
import type { SyncTier } from "../imap/capabilities.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("change-detector");

export interface FolderState {
  folderId: string;
  uidvalidity: bigint | null;
  highestmodseq: bigint | null;
  /** Server UIDNEXT as of the last recorded state; drives the QRESYNC tier's UID-range fetch. */
  uidnext: bigint | null;
  knownUids: Set<number>;
  /** Map of UID -> Set of flags for known messages */
  knownFlags: Map<number, Set<string>>;
}

export interface FlagChange {
  uid: number;
  flags: Set<string>;
  modseq?: bigint;
}

export interface ChangeSet {
  newUids: number[];
  deletedUids: number[];
  flagChanged: FlagChange[];
  uidValidityChanged: boolean;
}

const EMPTY_CHANGESET: ChangeSet = {
  newUids: [],
  deletedUids: [],
  flagChanged: [],
  uidValidityChanged: false,
};

/**
 * VANISHED and changed-FETCH responses collected while re-SELECTing the mailbox with
 * QRESYNC parameters (see `InboundSync.reselectForQresync` in `inbound.ts`). This is what
 * makes the qresync tier real: the server reports expunges and flag changes inline during
 * SELECT, so detection needs neither a UID SEARCH ALL nor a second round-trip.
 */
export interface QresyncSelectEvents {
  /** UIDs reported via VANISHED (EARLIER) during the QRESYNC SELECT. */
  vanishedUids: number[];
  /** Flag updates reported via untagged FETCH during the same SELECT. */
  flagUpdates: FlagChange[];
}

/**
 * Three-tier change detection. Auto-selects strategy based on server capabilities.
 *
 * Tier 1 (QRESYNC): the SELECT that opened the mailbox already carried QRESYNC
 * parameters and its VANISHED/FETCH responses were collected into `qresyncEvents` --
 * deletions and flag changes come from there, new messages from a UID-range fetch bounded
 * by UIDNEXT. Falls back to the CONDSTORE-equivalent CHANGEDSINCE+SEARCH path when the
 * caller couldn't do a parameterized reselect (no prior UIDVALIDITY/HIGHESTMODSEQ to pin
 * it to -- effectively only ever the account's very first qresync-tier cycle).
 * Tier 2 (CONDSTORE): FETCH FLAGS CHANGEDSINCE + UID SEARCH for new/deleted.
 * Tier 3 (full diff): SEARCH ALL + FETCH ALL FLAGS, compare against PG state.
 *
 * UIDs in pendingUids are excluded from flag comparison (loop guard).
 */
export async function detectChanges(
  client: ImapFlow,
  folder: FolderState,
  tier: SyncTier,
  pendingUids: Set<number>,
  qresyncEvents?: QresyncSelectEvents,
): Promise<ChangeSet> {
  const mailbox = client.mailbox;
  if (!mailbox) {
    throw new Error("No mailbox selected");
  }

  // UIDVALIDITY check: if changed, signal full resync
  if (folder.uidvalidity !== null && mailbox.uidValidity !== folder.uidvalidity) {
    log.warn(
      {
        folder: folder.folderId,
        oldValidity: folder.uidvalidity.toString(),
        newValidity: mailbox.uidValidity.toString(),
      },
      "UIDVALIDITY changed, full resync required",
    );
    return { ...EMPTY_CHANGESET, uidValidityChanged: true };
  }

  // First sync: no known UIDs means everything is new
  if (folder.knownUids.size === 0 && folder.uidvalidity === null) {
    return { ...EMPTY_CHANGESET, uidValidityChanged: true };
  }

  switch (tier) {
    case "qresync":
      return qresyncEvents
        ? detectQresyncFromEvents(client, folder, pendingUids, qresyncEvents)
        : detectQresync(client, folder, pendingUids);
    case "condstore":
      return detectCondstore(client, folder, pendingUids);
    case "full":
      return detectFull(client, folder, pendingUids);
  }
}

/**
 * Tier 1: QRESYNC, driven by the VANISHED/FETCH responses a parameterized SELECT already
 * collected (see `QresyncSelectEvents`). No UID SEARCH ALL anywhere on this path:
 * deletions are exactly the VANISHED UIDs, and new messages are found by fetching the UID
 * range from the last known UIDNEXT onward -- UIDs are strictly monotonic, so anything in
 * that range that isn't already known is new by definition.
 */
async function detectQresyncFromEvents(
  client: ImapFlow,
  folder: FolderState,
  pendingUids: Set<number>,
  events: QresyncSelectEvents,
): Promise<ChangeSet> {
  const result: ChangeSet = {
    newUids: [],
    deletedUids: [],
    flagChanged: [],
    uidValidityChanged: false,
  };

  for (const uid of events.vanishedUids) {
    if (folder.knownUids.has(uid)) {
      result.deletedUids.push(uid);
    }
  }

  // A newly-arrived message's FETCH (if the server included it here at all) is not a
  // flag *change* -- fetchAndStoreMessages below picks it up as a full insert instead.
  for (const update of events.flagUpdates) {
    if (folder.knownUids.has(update.uid) && !pendingUids.has(update.uid)) {
      result.flagChanged.push(update);
    }
  }

  const mailbox = client.mailbox;
  if (
    mailbox &&
    mailbox.exists > 0 &&
    folder.uidnext !== null &&
    BigInt(mailbox.uidNext) > folder.uidnext
  ) {
    const newUidsSet = new Set<number>();
    for await (const msg of client.fetch(`${folder.uidnext}:*`, { uid: true }, { uid: true })) {
      if (!folder.knownUids.has(msg.uid)) newUidsSet.add(msg.uid);
    }
    result.newUids = [...newUidsSet];
  }

  log.info(
    {
      tier: "qresync",
      newCount: result.newUids.length,
      deletedCount: result.deletedUids.length,
      flagChangedCount: result.flagChanged.length,
    },
    "Change detection complete",
  );

  return result;
}

/**
 * Tier 1 fallback: used only when the caller had no prior UIDVALIDITY/HIGHESTMODSEQ to
 * pin a QRESYNC reselect to (effectively the account's first qresync-tier cycle).
 * Functionally identical to the CONDSTORE tier -- CHANGEDSINCE FETCH plus a full UID
 * SEARCH -- until the next cycle has state to reselect against.
 */
async function detectQresync(
  client: ImapFlow,
  folder: FolderState,
  pendingUids: Set<number>,
): Promise<ChangeSet> {
  const result: ChangeSet = {
    newUids: [],
    deletedUids: [],
    flagChanged: [],
    uidValidityChanged: false,
  };

  // With QRESYNC, ImapFlow collects vanished UIDs and flag changes during SELECT.
  // We still need to do a search to find genuinely new messages and a FETCH
  // for any flag changes since our last known modseq.

  const highestModseq = folder.highestmodseq ?? BigInt(0);

  // Fetch flags changed since our last modseq
  if (highestModseq > BigInt(0)) {
    try {
      for await (const msg of client.fetch(
        "1:*",
        { uid: true, flags: true },
        { changedSince: highestModseq },
      )) {
        if (folder.knownUids.has(msg.uid)) {
          if (!pendingUids.has(msg.uid) && msg.flags) {
            result.flagChanged.push({
              uid: msg.uid,
              flags: msg.flags,
              modseq: msg.modseq,
            });
          }
        } else {
          result.newUids.push(msg.uid);
        }
      }
    } catch (err) {
      log.warn({ err }, "QRESYNC FETCH CHANGEDSINCE failed, falling back to full diff");
      return detectFull(client, folder, pendingUids);
    }
  }

  // Search all UIDs to detect deletions
  const remoteUids = await client.search({ all: true }, { uid: true });
  if (remoteUids === false) {
    log.warn("UID SEARCH returned false");
    return result;
  }

  const remoteUidSet = new Set(remoteUids);

  // Find deleted UIDs
  for (const uid of folder.knownUids) {
    if (!remoteUidSet.has(uid)) {
      result.deletedUids.push(uid);
    }
  }

  // Find any additional new UIDs not caught by CHANGEDSINCE
  for (const uid of remoteUids) {
    if (!folder.knownUids.has(uid) && !result.newUids.includes(uid)) {
      result.newUids.push(uid);
    }
  }

  log.info(
    {
      tier: "qresync",
      newCount: result.newUids.length,
      deletedCount: result.deletedUids.length,
      flagChangedCount: result.flagChanged.length,
    },
    "Change detection complete",
  );

  return result;
}

/**
 * Tier 2: CONDSTORE. Two round-trips:
 * 1. FETCH FLAGS CHANGEDSINCE for modified flags
 * 2. UID SEARCH ALL to detect new/deleted UIDs
 */
async function detectCondstore(
  client: ImapFlow,
  folder: FolderState,
  pendingUids: Set<number>,
): Promise<ChangeSet> {
  const result: ChangeSet = {
    newUids: [],
    deletedUids: [],
    flagChanged: [],
    uidValidityChanged: false,
  };

  const highestModseq = folder.highestmodseq ?? BigInt(0);

  // Fetch changed flags since our known modseq. "1:*" is an invalid message set on a
  // mailbox that currently holds zero messages (RFC 9051: "*" is the largest sequence
  // number, undefined when EXISTS is 0) -- some servers reject it outright rather than
  // returning nothing, so this only runs while there's at least one message to match.
  if (highestModseq > BigInt(0) && client.mailbox && client.mailbox.exists > 0) {
    for await (const msg of client.fetch(
      "1:*",
      { uid: true, flags: true },
      { changedSince: highestModseq },
    )) {
      if (folder.knownUids.has(msg.uid)) {
        if (!pendingUids.has(msg.uid) && msg.flags) {
          result.flagChanged.push({
            uid: msg.uid,
            flags: msg.flags,
            modseq: msg.modseq,
          });
        }
      } else {
        result.newUids.push(msg.uid);
      }
    }
  }

  // Search all UIDs to detect new and deleted
  const remoteUids = await client.search({ all: true }, { uid: true });
  if (remoteUids === false) {
    log.warn("UID SEARCH returned false");
    return result;
  }

  const remoteUidSet = new Set(remoteUids);

  for (const uid of folder.knownUids) {
    if (!remoteUidSet.has(uid)) {
      result.deletedUids.push(uid);
    }
  }

  for (const uid of remoteUids) {
    if (!folder.knownUids.has(uid) && !result.newUids.includes(uid)) {
      result.newUids.push(uid);
    }
  }

  log.info(
    {
      tier: "condstore",
      newCount: result.newUids.length,
      deletedCount: result.deletedUids.length,
      flagChangedCount: result.flagChanged.length,
    },
    "Change detection complete",
  );

  return result;
}

/**
 * Tier 3: Full diff. Fetches ALL UIDs and ALL flags, compares against PG state.
 * O(n) but works with any IMAP server.
 */
async function detectFull(
  client: ImapFlow,
  folder: FolderState,
  pendingUids: Set<number>,
): Promise<ChangeSet> {
  const result: ChangeSet = {
    newUids: [],
    deletedUids: [],
    flagChanged: [],
    uidValidityChanged: false,
  };

  // Search all UIDs
  const remoteUids = await client.search({ all: true }, { uid: true });
  if (remoteUids === false) {
    log.warn("UID SEARCH returned false");
    return result;
  }

  const remoteUidSet = new Set(remoteUids);

  // Find deleted UIDs
  for (const uid of folder.knownUids) {
    if (!remoteUidSet.has(uid)) {
      result.deletedUids.push(uid);
    }
  }

  // Find new UIDs
  for (const uid of remoteUids) {
    if (!folder.knownUids.has(uid)) {
      result.newUids.push(uid);
    }
  }

  // Fetch all flags to detect changes on existing messages
  if (folder.knownUids.size > 0 && remoteUids.length > 0) {
    for await (const msg of client.fetch("1:*", { uid: true, flags: true })) {
      if (!folder.knownUids.has(msg.uid)) continue;
      if (pendingUids.has(msg.uid)) continue;
      if (!msg.flags) continue;

      const knownFlags = folder.knownFlags.get(msg.uid);
      if (knownFlags && !flagSetsEqual(knownFlags, msg.flags)) {
        result.flagChanged.push({
          uid: msg.uid,
          flags: msg.flags,
        });
      }
    }
  }

  log.info(
    {
      tier: "full",
      newCount: result.newUids.length,
      deletedCount: result.deletedUids.length,
      flagChangedCount: result.flagChanged.length,
    },
    "Change detection complete",
  );

  return result;
}

/** Compare two flag Sets for equality */
function flagSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const flag of a) {
    if (!b.has(flag)) return false;
  }
  return true;
}
