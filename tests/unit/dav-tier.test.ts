import { describe, expect, test } from "vitest";
import { selectTier } from "../../src/dav/tier.js";

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
