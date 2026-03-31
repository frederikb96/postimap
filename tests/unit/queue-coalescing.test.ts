import { describe, expect, test } from "vitest";
import type { CoalesceResult } from "../../src/sync/outbound.js";

const { coalesce } = await import("../../src/sync/outbound.js");

/** Build a minimal QueueEntry for coalescing tests */
function makeEntry(overrides: {
  id?: string;
  message_id?: string | null;
  action: string;
  payload?: Record<string, unknown>;
  created_at?: Date;
}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    account_id: "acc-1",
    message_id: overrides.message_id ?? "msg-1",
    folder_id: "folder-1",
    action: overrides.action,
    payload: overrides.payload ?? {},
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    error: null,
    created_at: overrides.created_at ?? new Date(),
    processed_at: null,
    next_retry_at: new Date(),
    imap_uid: "42",
    modseq: "1",
  };
}

describe("coalesce — rapid flag toggles", () => {
  test("5 rapid is_seen toggles produce only 1 effective entry (final state)", () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        id: "1",
        action: "flag_add",
        payload: { flag: "\\Seen" },
        created_at: new Date(now),
      }),
      makeEntry({
        id: "2",
        action: "flag_remove",
        payload: { flag: "\\Seen" },
        created_at: new Date(now + 1),
      }),
      makeEntry({
        id: "3",
        action: "flag_add",
        payload: { flag: "\\Seen" },
        created_at: new Date(now + 2),
      }),
      makeEntry({
        id: "4",
        action: "flag_remove",
        payload: { flag: "\\Seen" },
        created_at: new Date(now + 3),
      }),
      makeEntry({
        id: "5",
        action: "flag_add",
        payload: { flag: "\\Seen" },
        created_at: new Date(now + 4),
      }),
    ];

    const result: CoalesceResult = coalesce(entries as never[]);

    expect(result.effective).toHaveLength(1);
    expect(result.superseded).toHaveLength(4);
    // The last entry (flag_add) should win
    expect(result.effective[0].id).toBe("5");
    expect(result.effective[0].action).toBe("flag_add");
  });
});

describe("coalesce — flag_add then flag_remove on same flag", () => {
  test("only the last action (flag_remove) survives", () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        id: "add",
        action: "flag_add",
        payload: { flag: "\\Flagged" },
        created_at: new Date(now),
      }),
      makeEntry({
        id: "rm",
        action: "flag_remove",
        payload: { flag: "\\Flagged" },
        created_at: new Date(now + 1),
      }),
    ];

    const result = coalesce(entries as never[]);

    expect(result.effective).toHaveLength(1);
    expect(result.effective[0].id).toBe("rm");
    expect(result.effective[0].action).toBe("flag_remove");
    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0].id).toBe("add");
  });
});

describe("coalesce — move deduplication", () => {
  test("move + move keeps only the last move destination", () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        id: "mv1",
        action: "move",
        payload: { from_folder_id: "A", to_folder_id: "B" },
        created_at: new Date(now),
      }),
      makeEntry({
        id: "mv2",
        action: "move",
        payload: { from_folder_id: "B", to_folder_id: "C" },
        created_at: new Date(now + 1),
      }),
    ];

    const result = coalesce(entries as never[]);

    const effectiveMoves = result.effective.filter((e) => e.action === "move");
    expect(effectiveMoves).toHaveLength(1);
    expect(effectiveMoves[0].id).toBe("mv2");
    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0].id).toBe("mv1");
  });
});

describe("coalesce — delete supersedes everything", () => {
  test("delete supersedes all prior flag and move entries for same message", () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        id: "f1",
        action: "flag_add",
        payload: { flag: "\\Seen" },
        created_at: new Date(now),
      }),
      makeEntry({
        id: "mv1",
        action: "move",
        payload: { to_folder_id: "B" },
        created_at: new Date(now + 1),
      }),
      makeEntry({
        id: "f2",
        action: "flag_add",
        payload: { flag: "\\Flagged" },
        created_at: new Date(now + 2),
      }),
      makeEntry({
        id: "del",
        action: "delete",
        payload: { folder_id: "A", imap_uid: "42" },
        created_at: new Date(now + 3),
      }),
    ];

    const result = coalesce(entries as never[]);

    expect(result.effective).toHaveLength(1);
    expect(result.effective[0].id).toBe("del");
    expect(result.effective[0].action).toBe("delete");
    expect(result.superseded).toHaveLength(3);
    const supersededIds = result.superseded.map((e) => e.id).sort();
    expect(supersededIds).toEqual(["f1", "f2", "mv1"]);
  });
});

describe("coalesce — mixed messages are independent", () => {
  test("coalescing per-message independently leaves other messages unaffected", () => {
    const now = Date.now();
    const entries = [
      // msg-1: two flag toggles -> 1 effective
      makeEntry({
        id: "m1-f1",
        message_id: "msg-1",
        action: "flag_add",
        payload: { flag: "\\Seen" },
        created_at: new Date(now),
      }),
      makeEntry({
        id: "m1-f2",
        message_id: "msg-1",
        action: "flag_remove",
        payload: { flag: "\\Seen" },
        created_at: new Date(now + 1),
      }),
      // msg-2: single flag add -> 1 effective
      makeEntry({
        id: "m2-f1",
        message_id: "msg-2",
        action: "flag_add",
        payload: { flag: "\\Flagged" },
        created_at: new Date(now),
      }),
    ];

    const result = coalesce(entries as never[]);

    expect(result.effective).toHaveLength(2);
    const effectiveIds = result.effective.map((e) => e.id).sort();
    expect(effectiveIds).toEqual(["m1-f2", "m2-f1"]);
    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0].id).toBe("m1-f1");
  });
});

describe("coalesce — empty batch", () => {
  test("empty input produces empty effective and superseded arrays", () => {
    const result = coalesce([]);
    expect(result.effective).toEqual([]);
    expect(result.superseded).toEqual([]);
  });
});

describe("coalesce — entries without message_id", () => {
  test("entries without message_id are treated as effective (cannot coalesce)", () => {
    const entries = [
      makeEntry({
        id: "orphan",
        message_id: null,
        action: "flag_add",
        payload: { flag: "\\Seen" },
      }),
    ];

    const result = coalesce(entries as never[]);
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0].id).toBe("orphan");
    expect(result.superseded).toEqual([]);
  });
});

describe("coalesce — multiple different flags preserved", () => {
  test("different flags on same message are NOT coalesced against each other", () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        id: "seen",
        action: "flag_add",
        payload: { flag: "\\Seen" },
        created_at: new Date(now),
      }),
      makeEntry({
        id: "flagged",
        action: "flag_add",
        payload: { flag: "\\Flagged" },
        created_at: new Date(now + 1),
      }),
    ];

    const result = coalesce(entries as never[]);

    expect(result.effective).toHaveLength(2);
    const effectiveIds = result.effective.map((e) => e.id).sort();
    expect(effectiveIds).toEqual(["flagged", "seen"]);
    expect(result.superseded).toEqual([]);
  });
});
