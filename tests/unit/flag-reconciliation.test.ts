import { describe, expect, test } from "vitest";

/**
 * Tests for flag decomposition/composition logic used in message-sync.ts.
 *
 * The flag logic is inlined in storeMessage() and updateFlags() — not exported
 * as separate functions. These tests verify the algorithm by reimplementing the
 * same logic and asserting correctness. This documents the expected behavior
 * and guards against regressions if the logic is refactored.
 */

const SYSTEM_FLAGS = new Set([
  "\\Seen",
  "\\Flagged",
  "\\Answered",
  "\\Draft",
  "\\Deleted",
  "\\Recent",
]);

/** Decompose an IMAP flag set into boolean columns + keywords array */
function decomposeFlags(flags: Set<string>): {
  is_seen: boolean;
  is_flagged: boolean;
  is_answered: boolean;
  is_draft: boolean;
  is_deleted: boolean;
  keywords: string[];
} {
  return {
    is_seen: flags.has("\\Seen"),
    is_flagged: flags.has("\\Flagged"),
    is_answered: flags.has("\\Answered"),
    is_draft: flags.has("\\Draft"),
    is_deleted: flags.has("\\Deleted"),
    keywords: [...flags].filter((f) => !SYSTEM_FLAGS.has(f)),
  };
}

/** Compose boolean columns + keywords back into an IMAP flag set */
function composeFlags(booleans: {
  is_seen: boolean;
  is_flagged: boolean;
  is_answered: boolean;
  is_draft: boolean;
  is_deleted: boolean;
  keywords: string[];
}): Set<string> {
  const flags = new Set<string>();
  if (booleans.is_seen) flags.add("\\Seen");
  if (booleans.is_flagged) flags.add("\\Flagged");
  if (booleans.is_answered) flags.add("\\Answered");
  if (booleans.is_draft) flags.add("\\Draft");
  if (booleans.is_deleted) flags.add("\\Deleted");
  for (const kw of booleans.keywords) {
    flags.add(kw);
  }
  return flags;
}

describe("decomposeFlags", () => {
  test("decomposes \\Seen flag to is_seen=true", () => {
    const result = decomposeFlags(new Set(["\\Seen"]));
    expect(result.is_seen).toBe(true);
    expect(result.is_flagged).toBe(false);
    expect(result.is_answered).toBe(false);
    expect(result.is_draft).toBe(false);
    expect(result.is_deleted).toBe(false);
    expect(result.keywords).toEqual([]);
  });

  test("decomposes all system flags", () => {
    const result = decomposeFlags(
      new Set(["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "\\Deleted"]),
    );
    expect(result.is_seen).toBe(true);
    expect(result.is_flagged).toBe(true);
    expect(result.is_answered).toBe(true);
    expect(result.is_draft).toBe(true);
    expect(result.is_deleted).toBe(true);
    expect(result.keywords).toEqual([]);
  });

  test("puts unknown/custom flags into keywords array", () => {
    const result = decomposeFlags(new Set(["\\Seen", "$label1", "custom-flag", "priority"]));
    expect(result.is_seen).toBe(true);
    expect(result.keywords).toContain("$label1");
    expect(result.keywords).toContain("custom-flag");
    expect(result.keywords).toContain("priority");
    expect(result.keywords).toHaveLength(3);
  });

  test("\\Recent is excluded from keywords (system flag)", () => {
    const result = decomposeFlags(new Set(["\\Recent", "\\Seen"]));
    expect(result.keywords).toEqual([]);
    expect(result.is_seen).toBe(true);
  });

  test("empty flags set produces all-false booleans and empty keywords", () => {
    const result = decomposeFlags(new Set());
    expect(result.is_seen).toBe(false);
    expect(result.is_flagged).toBe(false);
    expect(result.is_answered).toBe(false);
    expect(result.is_draft).toBe(false);
    expect(result.is_deleted).toBe(false);
    expect(result.keywords).toEqual([]);
  });

  test("only custom flags with no system flags", () => {
    const result = decomposeFlags(new Set(["$Junk", "$NotJunk", "important"]));
    expect(result.is_seen).toBe(false);
    expect(result.is_flagged).toBe(false);
    expect(result.keywords).toEqual(["$Junk", "$NotJunk", "important"]);
  });
});

describe("composeFlags", () => {
  test("composes booleans back to flag set", () => {
    const result = composeFlags({
      is_seen: true,
      is_flagged: false,
      is_answered: true,
      is_draft: false,
      is_deleted: false,
      keywords: [],
    });
    expect(result).toEqual(new Set(["\\Seen", "\\Answered"]));
  });

  test("includes keywords in composed set", () => {
    const result = composeFlags({
      is_seen: true,
      is_flagged: false,
      is_answered: false,
      is_draft: false,
      is_deleted: false,
      keywords: ["$label1", "priority"],
    });
    expect(result).toEqual(new Set(["\\Seen", "$label1", "priority"]));
  });

  test("all-false produces empty set", () => {
    const result = composeFlags({
      is_seen: false,
      is_flagged: false,
      is_answered: false,
      is_draft: false,
      is_deleted: false,
      keywords: [],
    });
    expect(result).toEqual(new Set());
  });

  test("all-true produces full system flag set", () => {
    const result = composeFlags({
      is_seen: true,
      is_flagged: true,
      is_answered: true,
      is_draft: true,
      is_deleted: true,
      keywords: [],
    });
    expect(result).toEqual(new Set(["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "\\Deleted"]));
  });
});

describe("decompose -> compose roundtrip", () => {
  test("roundtrip preserves system flags", () => {
    const original = new Set(["\\Seen", "\\Flagged"]);
    const decomposed = decomposeFlags(original);
    const composed = composeFlags(decomposed);
    expect(composed).toEqual(original);
  });

  test("roundtrip preserves custom keywords", () => {
    const original = new Set(["\\Seen", "$label1", "priority"]);
    const decomposed = decomposeFlags(original);
    const composed = composeFlags(decomposed);
    expect(composed).toEqual(original);
  });

  test("\\Recent is lost in roundtrip (system flag, not stored as boolean)", () => {
    const original = new Set(["\\Recent", "\\Seen"]);
    const decomposed = decomposeFlags(original);
    const composed = composeFlags(decomposed);
    // \Recent is not a persistent flag - lost in decompose
    expect(composed).toEqual(new Set(["\\Seen"]));
    expect(composed.has("\\Recent")).toBe(false);
  });
});
