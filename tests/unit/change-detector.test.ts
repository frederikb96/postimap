import { describe, expect, test, vi } from "vitest";
import type { FolderState } from "../../src/sync/change-detector.js";

/**
 * Unit tests for the change-detector module.
 *
 * The exported detectChanges() function requires an ImapFlow client and performs
 * async IMAP operations, so we mock the ImapFlow client to test the algorithms
 * in isolation.
 */

/** Helper to create an async iterable from an array (mocks client.fetch) */
function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false };
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

/** An async iterable that throws on the first `next()`, mimicking a failed FETCH. */
function asyncIterThrow<T>(err: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          throw err;
        },
      };
    },
  };
}

/** Build a minimal mock ImapFlow client for change-detector */
function buildMockClient(opts: {
  uidValidity?: bigint;
  uidNext?: number;
  /** Defaults to searchResult's length when omitted, and to fetchResults' length if that's also omitted. */
  exists?: number;
  searchResult?: number[] | false;
  fetchResults?: Array<{ uid: number; flags: Set<string>; modseq?: bigint }>;
  highestModseq?: bigint;
}) {
  const impliedExists =
    opts.searchResult && opts.searchResult !== false
      ? opts.searchResult.length
      : (opts.fetchResults?.length ?? 0);
  return {
    mailbox: {
      uidValidity: opts.uidValidity ?? BigInt(1),
      uidNext: opts.uidNext ?? 100,
      exists: opts.exists ?? impliedExists,
      highestModseq: opts.highestModseq ?? BigInt(1),
    },
    search: vi.fn().mockResolvedValue(opts.searchResult ?? []),
    fetch: vi.fn().mockReturnValue(asyncIter(opts.fetchResults ?? [])),
  };
}

/** Build a FolderState for testing */
function buildFolderState(opts?: {
  uidvalidity?: bigint | null;
  highestmodseq?: bigint | null;
  uidnext?: bigint | null;
  lastSyncedAt?: Date | null;
  knownUids?: number[];
  knownFlags?: Map<number, Set<string>>;
}): FolderState {
  const uids = opts?.knownUids ?? [];
  return {
    folderId: "test-folder-id",
    uidvalidity: opts?.uidvalidity !== undefined ? opts.uidvalidity : BigInt(1),
    highestmodseq: opts?.highestmodseq !== undefined ? opts.highestmodseq : BigInt(0),
    uidnext: opts?.uidnext !== undefined ? opts.uidnext : null,
    lastSyncedAt: opts?.lastSyncedAt !== undefined ? opts.lastSyncedAt : null,
    knownUids: new Set(uids),
    knownFlags: opts?.knownFlags ?? new Map(),
  };
}

// We dynamically import to allow vitest to properly resolve the module
const { detectChanges } = await import("../../src/sync/change-detector.js");

describe("detectChanges — UIDVALIDITY check", () => {
  test("returns uidValidityChanged=true when UIDVALIDITY differs from stored value", async () => {
    const client = buildMockClient({ uidValidity: BigInt(99) });
    const folder = buildFolderState({ uidvalidity: BigInt(1), knownUids: [1, 2, 3] });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.uidValidityChanged).toBe(true);
    expect(result.newUids).toEqual([]);
    expect(result.deletedUids).toEqual([]);
    expect(result.flagChanged).toEqual([]);
  });

  test("returns uidValidityChanged=true on first sync (null uidvalidity, empty knownUids)", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1) });
    const folder = buildFolderState({ uidvalidity: null, knownUids: [] });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.uidValidityChanged).toBe(true);
  });

  test("does not flag uidValidityChanged when UIDVALIDITY matches", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(42),
      searchResult: [1, 2, 3],
    });
    const folder = buildFolderState({ uidvalidity: BigInt(42), knownUids: [1, 2, 3] });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.uidValidityChanged).toBe(false);
  });
});

describe("detectChanges — UID diff logic (full tier)", () => {
  test("identifies new UIDs on the remote server", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 2, 3, 4, 5],
    });
    const folder = buildFolderState({
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set(["\\Seen"])],
        [2, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.newUids).toContain(4);
    expect(result.newUids).toContain(5);
    expect(result.deletedUids).toEqual([]);
  });

  test("identifies deleted UIDs (locally known but not on remote)", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 3],
    });
    const folder = buildFolderState({
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.deletedUids).toContain(2);
    expect(result.newUids).toEqual([]);
  });

  test("identifies both new and deleted UIDs simultaneously", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 4, 5],
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen"]) },
        { uid: 4, flags: new Set<string>() },
        { uid: 5, flags: new Set<string>() },
      ],
    });
    const folder = buildFolderState({
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set(["\\Seen"])],
        [2, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.newUids).toContain(4);
    expect(result.newUids).toContain(5);
    expect(result.deletedUids).toContain(2);
    expect(result.deletedUids).toContain(3);
  });

  test("returns empty ChangeSet when local and remote are in sync", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 2, 3],
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen"]) },
        { uid: 2, flags: new Set<string>() },
        { uid: 3, flags: new Set(["\\Flagged"]) },
      ],
    });
    const folder = buildFolderState({
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set(["\\Seen"])],
        [2, new Set<string>()],
        [3, new Set(["\\Flagged"])],
      ]),
    });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.newUids).toEqual([]);
    expect(result.deletedUids).toEqual([]);
    expect(result.flagChanged).toEqual([]);
  });
});

describe("detectChanges — flag comparison (full tier)", () => {
  test("detects flag changes on existing messages", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 2],
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen", "\\Flagged"]) },
        { uid: 2, flags: new Set<string>() },
      ],
    });
    const folder = buildFolderState({
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set(["\\Seen"])],
        [2, new Set(["\\Seen"])],
      ]),
    });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.flagChanged).toHaveLength(2);

    const changed1 = result.flagChanged.find((c: { uid: number }) => c.uid === 1);
    expect(changed1).toBeDefined();
    expect(changed1?.flags).toEqual(new Set(["\\Seen", "\\Flagged"]));

    const changed2 = result.flagChanged.find((c: { uid: number }) => c.uid === 2);
    expect(changed2).toBeDefined();
    expect(changed2?.flags).toEqual(new Set());
  });

  test("does not report flag changes when flags match", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1],
      fetchResults: [{ uid: 1, flags: new Set(["\\Seen"]) }],
    });
    const folder = buildFolderState({
      knownUids: [1],
      knownFlags: new Map([[1, new Set(["\\Seen"])]]),
    });

    const result = await detectChanges(client as never, folder, "full", new Set());
    expect(result.flagChanged).toEqual([]);
  });
});

describe("detectChanges — pending-queue filter", () => {
  test("excludes UIDs in pendingUids set from flag comparison", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 2, 3],
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen", "\\Flagged"]) },
        { uid: 2, flags: new Set(["\\Answered"]) },
        { uid: 3, flags: new Set<string>() },
      ],
    });
    const folder = buildFolderState({
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set(["\\Seen"])],
        [2, new Set<string>()],
        [3, new Set(["\\Flagged"])],
      ]),
    });

    // UIDs 1 and 2 are pending outbound, only UID 3 should appear in flagChanged
    const pendingUids = new Set([1, 2]);
    const result = await detectChanges(client as never, folder, "full", pendingUids);
    expect(result.flagChanged).toHaveLength(1);
    expect(result.flagChanged[0].uid).toBe(3);
  });

  test("pending UIDs are still detected as new/deleted (only flag comparison is skipped)", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 4], // UID 2 deleted, UID 4 new
    });
    const folder = buildFolderState({
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const pendingUids = new Set([1, 2]); // All known UIDs are pending
    const result = await detectChanges(client as never, folder, "full", pendingUids);
    expect(result.newUids).toContain(4);
    expect(result.deletedUids).toContain(2);
  });
});

describe("detectChanges — condstore tier", () => {
  test("fetches flag changes via CHANGEDSINCE and detects new/deleted via UID search", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      highestModseq: BigInt(10),
      searchResult: [1, 3, 4], // UID 2 deleted, UID 4 new
      fetchResults: [{ uid: 1, flags: new Set(["\\Seen"]), modseq: BigInt(10) }],
    });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "condstore", new Set());

    expect(result.uidValidityChanged).toBe(false);
    expect(result.flagChanged).toEqual([
      { uid: 1, flags: new Set(["\\Seen"]), modseq: BigInt(10) },
    ]);
    expect(result.newUids).toEqual([4]);
    expect(result.deletedUids).toEqual([2]);
  });

  test("does not fetch CHANGEDSINCE when highestmodseq is zero (first CONDSTORE-tier sync)", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1), searchResult: [1, 2] });
    const folder = buildFolderState({
      highestmodseq: BigInt(0),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "condstore", new Set());

    expect(client.fetch).not.toHaveBeenCalled();
    expect(result.flagChanged).toEqual([]);
  });

  test("does not issue the CHANGEDSINCE FETCH against an empty mailbox (invalid message set on some servers)", async () => {
    // Last known message was deleted -- server search now returns empty, and mailbox
    // state (derived by buildMockClient from searchResult) reflects EXISTS=0. "1:*" is
    // invalid there on servers that reject it outright rather than returning nothing.
    const client = buildMockClient({
      uidValidity: BigInt(1),
      highestModseq: BigInt(10),
      searchResult: [],
    });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      knownUids: [1],
      knownFlags: new Map([[1, new Set<string>()]]),
    });

    const result = await detectChanges(client as never, folder, "condstore", new Set());

    expect(client.fetch).not.toHaveBeenCalled();
    expect(result.deletedUids).toEqual([1]);
  });

  test("excludes pending UIDs from CONDSTORE flag comparison", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      highestModseq: BigInt(10),
      searchResult: [1, 2],
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen"]) },
        { uid: 2, flags: new Set(["\\Flagged"]) },
      ],
    });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "condstore", new Set([1]));

    expect(result.flagChanged).toHaveLength(1);
    expect(result.flagChanged[0].uid).toBe(2);
  });
});

describe("detectChanges — qresync tier (legacy CHANGEDSINCE+search fallback, no reselect events)", () => {
  test("fetches flag changes via CHANGEDSINCE and detects new/deleted via UID search", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      highestModseq: BigInt(10),
      searchResult: [1, 3, 4], // UID 2 deleted (VANISHED), UID 4 new
      fetchResults: [{ uid: 1, flags: new Set(["\\Seen"]), modseq: BigInt(10) }],
    });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set());

    expect(result.flagChanged).toEqual([
      { uid: 1, flags: new Set(["\\Seen"]), modseq: BigInt(10) },
    ]);
    expect(result.newUids).toEqual([4]);
    expect(result.deletedUids).toEqual([2]);
  });

  test("falls back to full diff when the CHANGEDSINCE FETCH fails", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      searchResult: [1, 2],
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen"]) },
        { uid: 2, flags: new Set<string>() },
      ],
    });
    // First call (QRESYNC's CHANGEDSINCE fetch) throws; detectFull's own fetch call
    // (mocked the same way) then succeeds and drives the fallback path.
    (client.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      asyncIterThrow(new Error("FETCH CHANGEDSINCE failed")),
    );
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set());

    // Recovered via detectFull: flag change on UID 1 detected by comparing knownFlags.
    expect(result.flagChanged).toEqual([{ uid: 1, flags: new Set(["\\Seen"]) }]);
    expect(result.newUids).toEqual([]);
    expect(result.deletedUids).toEqual([]);
  });

  test("does not fetch CHANGEDSINCE when highestmodseq is zero (first QRESYNC-tier sync)", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1), searchResult: [1, 2] });
    const folder = buildFolderState({
      highestmodseq: BigInt(0),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set());

    expect(client.fetch).not.toHaveBeenCalled();
    expect(result.flagChanged).toEqual([]);
  });
});

describe("detectChanges — qresync tier (event-driven, real QRESYNC reselect)", () => {
  test("deletions come directly from VANISHED events, no UID SEARCH", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1), uidNext: 100 });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      uidnext: BigInt(100),
      knownUids: [1, 2, 3],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set(), {
      vanishedUids: [2],
      flagUpdates: [],
    });

    expect(result.deletedUids).toEqual([2]);
    expect(client.search).not.toHaveBeenCalled();
  });

  test("ignores a VANISHED UID that isn't currently known (already reconciled)", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1), uidNext: 100 });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      uidnext: BigInt(100),
      knownUids: [1, 3],
      knownFlags: new Map([
        [1, new Set<string>()],
        [3, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set(), {
      vanishedUids: [2],
      flagUpdates: [],
    });

    expect(result.deletedUids).toEqual([]);
  });

  test("flag updates from the reselect apply only to known, non-pending UIDs", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1), uidNext: 100 });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      uidnext: BigInt(100),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set([2]), {
      vanishedUids: [],
      flagUpdates: [
        { uid: 1, flags: new Set(["\\Seen"]), modseq: BigInt(6) },
        { uid: 2, flags: new Set(["\\Flagged"]), modseq: BigInt(6) }, // pending, excluded
        { uid: 99, flags: new Set(["\\Seen"]), modseq: BigInt(6) }, // not yet known, ignored here
      ],
    });

    expect(result.flagChanged).toEqual([{ uid: 1, flags: new Set(["\\Seen"]), modseq: BigInt(6) }]);
  });

  test("new messages come from a UIDNEXT-range fetch, not a UID SEARCH", async () => {
    const client = buildMockClient({
      uidValidity: BigInt(1),
      uidNext: 103,
      fetchResults: [
        { uid: 100, flags: new Set<string>() },
        { uid: 101, flags: new Set<string>() },
        { uid: 102, flags: new Set<string>() },
      ],
    });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      uidnext: BigInt(100),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set(), {
      vanishedUids: [],
      flagUpdates: [],
    });

    expect(result.newUids).toEqual([100, 101, 102]);
    expect(client.search).not.toHaveBeenCalled();
    expect(client.fetch).toHaveBeenCalledWith("100:*", { uid: true }, { uid: true });
  });

  test("skips the range fetch entirely when UIDNEXT hasn't advanced (no new mail)", async () => {
    const client = buildMockClient({ uidValidity: BigInt(1), uidNext: 100 });
    const folder = buildFolderState({
      highestmodseq: BigInt(5),
      uidnext: BigInt(100),
      knownUids: [1, 2],
      knownFlags: new Map([
        [1, new Set<string>()],
        [2, new Set<string>()],
      ]),
    });

    const result = await detectChanges(client as never, folder, "qresync", new Set(), {
      vanishedUids: [],
      flagUpdates: [],
    });

    expect(result.newUids).toEqual([]);
    expect(client.fetch).not.toHaveBeenCalled();
  });
});

describe("detectChanges — throws on no mailbox", () => {
  test("throws when no mailbox is selected", async () => {
    const client = { mailbox: null } as never;
    const folder = buildFolderState();

    await expect(detectChanges(client, folder, "full", new Set())).rejects.toThrow(
      "No mailbox selected",
    );
  });
});

describe("detectChanges — full tier skips a cycle whose mailbox counters have not moved", () => {
  const MAX_SKIP_MS = 600_000;

  test("no UID SEARCH when UIDNEXT and the message count both match the last sync", async () => {
    // On this tier every cycle otherwise pays a UID SEARCH plus a fetch of every flag set,
    // and the already-held SELECT answers both counter questions for nothing.
    const client = buildMockClient({ uidNext: 100, exists: 3, searchResult: [1, 2, 3] });
    const folder = buildFolderState({
      uidnext: BigInt(100),
      knownUids: [1, 2, 3],
      lastSyncedAt: new Date(),
    });

    const result = await detectChanges(
      client as never,
      folder,
      "full",
      new Set(),
      undefined,
      MAX_SKIP_MS,
    );

    expect(result.skipped).toBe(true);
    expect(client.search).not.toHaveBeenCalled();
    expect(result.newUids).toEqual([]);
    expect(result.deletedUids).toEqual([]);
    expect(result.flagChanged).toEqual([]);
  });

  test("a moved UIDNEXT is not skipped", async () => {
    const client = buildMockClient({ uidNext: 104, exists: 4, searchResult: [1, 2, 3, 4] });
    const folder = buildFolderState({
      uidnext: BigInt(100),
      knownUids: [1, 2, 3],
      lastSyncedAt: new Date(),
    });

    const result = await detectChanges(
      client as never,
      folder,
      "full",
      new Set(),
      undefined,
      MAX_SKIP_MS,
    );

    expect(result.skipped).toBeFalsy();
    expect(client.search).toHaveBeenCalled();
    expect(result.newUids).toEqual([4]);
  });

  test("the skip expires, so a flag changed elsewhere is still found", async () => {
    // A flag change by another client moves neither counter. Nothing would ever notice it
    // if the skip were trusted indefinitely.
    const client = buildMockClient({
      uidNext: 100,
      exists: 3,
      searchResult: [1, 2, 3],
      fetchResults: [{ uid: 2, flags: new Set(["\\Seen"]) }],
    });
    const folder = buildFolderState({
      uidnext: BigInt(100),
      knownUids: [1, 2, 3],
      knownFlags: new Map([[2, new Set<string>()]]),
      lastSyncedAt: new Date(Date.now() - MAX_SKIP_MS - 1_000),
    });

    const result = await detectChanges(
      client as never,
      folder,
      "full",
      new Set(),
      undefined,
      MAX_SKIP_MS,
    );

    expect(result.skipped).toBeFalsy();
    expect(client.search).toHaveBeenCalled();
    expect(result.flagChanged.map((c) => c.uid)).toEqual([2]);
  });

  test("skipping is off entirely when the window is zero", async () => {
    const client = buildMockClient({ uidNext: 100, exists: 3, searchResult: [1, 2, 3] });
    const folder = buildFolderState({
      uidnext: BigInt(100),
      knownUids: [1, 2, 3],
      lastSyncedAt: new Date(),
    });

    const result = await detectChanges(client as never, folder, "full", new Set(), undefined, 0);

    expect(result.skipped).toBeFalsy();
    expect(client.search).toHaveBeenCalled();
  });
});
