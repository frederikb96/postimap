import { describe, expect, test, vi } from "vitest";
import type { ChangeSet, FolderState } from "../../src/sync/change-detector.js";

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

/** Build a minimal mock ImapFlow client for change-detector */
function buildMockClient(opts: {
  uidValidity?: bigint;
  searchResult?: number[] | false;
  fetchResults?: Array<{ uid: number; flags: Set<string>; modseq?: bigint }>;
  highestModseq?: bigint;
}) {
  return {
    mailbox: {
      uidValidity: opts.uidValidity ?? BigInt(1),
      uidNext: 100,
      exists: opts.searchResult && opts.searchResult !== false ? opts.searchResult.length : 0,
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
  knownUids?: number[];
  knownFlags?: Map<number, Set<string>>;
}): FolderState {
  const uids = opts?.knownUids ?? [];
  return {
    folderId: "test-folder-id",
    uidvalidity: opts?.uidvalidity !== undefined ? opts.uidvalidity : BigInt(1),
    highestmodseq: opts?.highestmodseq !== undefined ? opts.highestmodseq : BigInt(0),
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

describe("detectChanges — throws on no mailbox", () => {
  test("throws when no mailbox is selected", async () => {
    const client = { mailbox: null } as never;
    const folder = buildFolderState();

    await expect(detectChanges(client, folder, "full", new Set())).rejects.toThrow(
      "No mailbox selected",
    );
  });
});
