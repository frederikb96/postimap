import { describe, expect, test } from "vitest";
import { formatUidSet, parseUidSet } from "../../src/util/uid-set.js";

describe("parseUidSet", () => {
  test("parses a simple range", () => {
    expect(parseUidSet("1:5")).toEqual([1, 2, 3, 4, 5]);
  });

  test("parses comma-separated individual UIDs", () => {
    expect(parseUidSet("1,3,5")).toEqual([1, 3, 5]);
  });

  test("parses mixed ranges and individual UIDs", () => {
    expect(parseUidSet("1:3,7,10:12")).toEqual([1, 2, 3, 7, 10, 11, 12]);
  });

  test("handles empty string", () => {
    expect(parseUidSet("")).toEqual([]);
  });

  test("handles whitespace-only string", () => {
    expect(parseUidSet("   ")).toEqual([]);
  });

  test("handles single UID", () => {
    expect(parseUidSet("42")).toEqual([42]);
  });

  test("handles reversed range (e.g. 5:1)", () => {
    expect(parseUidSet("5:1")).toEqual([1, 2, 3, 4, 5]);
  });

  test("skips * token in individual position", () => {
    expect(parseUidSet("1,*,3")).toEqual([1, 3]);
  });

  test("skips ranges containing *", () => {
    expect(parseUidSet("1:*")).toEqual([]);
    expect(parseUidSet("*:5")).toEqual([]);
  });

  test("handles whitespace around parts", () => {
    expect(parseUidSet(" 1 , 3 , 5 ")).toEqual([1, 3, 5]);
  });

  test("skips NaN entries", () => {
    expect(parseUidSet("1,abc,3")).toEqual([1, 3]);
  });

  test("handles single-element range (e.g. 5:5)", () => {
    expect(parseUidSet("5:5")).toEqual([5]);
  });
});

describe("formatUidSet", () => {
  test("formats consecutive UIDs as a range", () => {
    expect(formatUidSet([1, 2, 3, 5, 7, 8, 9])).toBe("1:3,5,7:9");
  });

  test("returns empty string for empty input", () => {
    expect(formatUidSet([])).toBe("");
  });

  test("formats a single UID", () => {
    expect(formatUidSet([42])).toBe("42");
  });

  test("deduplicates UIDs", () => {
    expect(formatUidSet([1, 1, 2, 2, 3])).toBe("1:3");
  });

  test("sorts unsorted input", () => {
    expect(formatUidSet([9, 1, 5, 3])).toBe("1,3,5,9");
  });

  test("handles all-consecutive UIDs", () => {
    expect(formatUidSet([10, 11, 12, 13, 14])).toBe("10:14");
  });

  test("handles all-non-consecutive UIDs", () => {
    expect(formatUidSet([1, 3, 5, 7])).toBe("1,3,5,7");
  });

  test("handles large range", () => {
    const uids = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(formatUidSet(uids)).toBe("1:1000");
  });
});

describe("parseUidSet + formatUidSet roundtrip", () => {
  test("format -> parse roundtrip preserves UIDs", () => {
    const original = [1, 2, 3, 7, 10, 11, 12];
    const formatted = formatUidSet(original);
    const parsed = parseUidSet(formatted);
    expect(parsed).toEqual(original);
  });

  test("parse -> format roundtrip produces compact form", () => {
    const parsed = parseUidSet("1,2,3,5,6,7");
    const formatted = formatUidSet(parsed);
    expect(formatted).toBe("1:3,5:7");
  });
});
