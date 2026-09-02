import { describe, expect, test } from "vitest";
import { collectionUnchanged, selectTier } from "../../src/dav/tier.js";

describe("selectTier", () => {
  test("returns 'sync' when sync-collection is advertised and a token is present", () => {
    expect(
      selectTier({
        supportedReports: ["syncCollection", "calendarMultiget"],
        syncToken: "abc",
        ctag: "x",
      }),
    ).toBe("sync");
  });

  test("falls back to 'ctag' when sync-collection is advertised but no token was returned", () => {
    // Nextcloud's contactsinteraction address book advertises getctag but refuses
    // REPORT sync-collection with 415 -- so a report name alone is not enough.
    expect(selectTier({ supportedReports: ["syncCollection"], syncToken: null, ctag: "x" })).toBe(
      "ctag",
    );
  });

  test("falls back to 'ctag' when sync-collection is not in supported-report-set", () => {
    expect(selectTier({ supportedReports: ["calendarMultiget"], syncToken: null, ctag: "x" })).toBe(
      "ctag",
    );
  });

  test("falls back to 'full' when neither a token nor a ctag is available", () => {
    expect(selectTier({ supportedReports: [], syncToken: null, ctag: null })).toBe("full");
  });

  test("tier selection is per collection, not per server -- two collections can differ", () => {
    const syncCapable = selectTier({
      supportedReports: ["syncCollection"],
      syncToken: "t",
      ctag: "c",
    });
    const ctagOnly = selectTier({ supportedReports: [], syncToken: null, ctag: "c" });
    expect(syncCapable).toBe("sync");
    expect(ctagOnly).toBe("ctag");
  });
});

describe("collectionUnchanged", () => {
  test("a sync-tier collection whose stored token matches the listing is skipped", () => {
    const stored = { syncToken: "http://x/sync/5", ctag: null };
    const server = { syncToken: "http://x/sync/5", ctag: "ignored" };
    expect(collectionUnchanged("sync", stored, server)).toBe(true);
    expect(collectionUnchanged("sync", stored, { ...server, syncToken: "http://x/sync/6" })).toBe(
      false,
    );
  });

  test("a ctag-tier collection is judged on ctag alone", () => {
    const stored = { syncToken: null, ctag: "c1" };
    expect(collectionUnchanged("ctag", stored, { syncToken: null, ctag: "c1" })).toBe(true);
    expect(collectionUnchanged("ctag", stored, { syncToken: null, ctag: "c2" })).toBe(false);
  });

  test("nothing stored yet is unknown, never unchanged -- a fresh collection must be read", () => {
    expect(
      collectionUnchanged("sync", { syncToken: null, ctag: null }, { syncToken: null, ctag: null }),
    ).toBe(false);
    expect(
      collectionUnchanged("ctag", { syncToken: null, ctag: null }, { syncToken: null, ctag: null }),
    ).toBe(false);
  });

  test("the full tier has no change proof and never skips", () => {
    expect(
      collectionUnchanged("full", { syncToken: "t", ctag: "c" }, { syncToken: "t", ctag: "c" }),
    ).toBe(false);
    expect(
      collectionUnchanged(null, { syncToken: "t", ctag: "c" }, { syncToken: "t", ctag: "c" }),
    ).toBe(false);
  });
});
