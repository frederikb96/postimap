import { describe, expect, test } from "vitest";
import { sanitizeNulBytesDeep, stripNulBytes } from "../../src/util/sanitize.js";

const NUL = String.fromCharCode(0);

describe("stripNulBytes", () => {
  test("removes an embedded NUL byte, keeping the rest of the string intact", () => {
    expect(stripNulBytes(`Hello${NUL}World`)).toBe("HelloWorld");
  });

  test("removes multiple NUL bytes anywhere in the string", () => {
    expect(stripNulBytes(`${NUL}a${NUL}${NUL}b${NUL}`)).toBe("ab");
  });

  test("leaves a string with no NUL byte untouched", () => {
    expect(stripNulBytes("Ünïcode, no problem")).toBe("Ünïcode, no problem");
  });

  test("does not substitute a replacement character for the removed byte", () => {
    const result = stripNulBytes(`a${NUL}b`);
    expect(result).toBe("ab");
    expect(result).not.toContain("�");
  });
});

describe("sanitizeNulBytesDeep", () => {
  test("passes null and undefined through unchanged", () => {
    expect(sanitizeNulBytesDeep(null)).toBeNull();
    expect(sanitizeNulBytesDeep(undefined)).toBeUndefined();
  });

  test("sanitizes every string inside an array", () => {
    expect(sanitizeNulBytesDeep([`a${NUL}b`, "c", `${NUL}d`])).toEqual(["ab", "c", "d"]);
  });

  test("sanitizes every string value inside a plain object, keys untouched", () => {
    expect(sanitizeNulBytesDeep({ "X-Header": `va${NUL}lue`, plain: "fine" })).toEqual({
      "X-Header": "value",
      plain: "fine",
    });
  });

  test("recurses through nested arrays and objects together", () => {
    expect(
      sanitizeNulBytesDeep({
        addrs: [`a${NUL}@test.local`, "b@test.local"],
        headers: { subject: `S${NUL}ubject` },
      }),
    ).toEqual({
      addrs: ["a@test.local", "b@test.local"],
      headers: { subject: "Subject" },
    });
  });

  test("leaves a Date value untouched rather than treating it as a plain object", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(sanitizeNulBytesDeep(date)).toBe(date);
  });
});
