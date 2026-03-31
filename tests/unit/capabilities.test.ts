import { describe, expect, test } from "vitest";
import {
  type ServerCapabilities,
  type SyncTier,
  selectSyncTier,
} from "../../src/imap/capabilities.js";

describe("selectSyncTier", () => {
  const baseCaps: ServerCapabilities = {
    condstore: false,
    qresync: false,
    idle: false,
    move: false,
    uidplus: false,
    mailboxId: false,
  };

  test("returns 'qresync' when QRESYNC is available", () => {
    expect(selectSyncTier({ ...baseCaps, qresync: true, condstore: true })).toBe("qresync");
  });

  test("returns 'condstore' when CONDSTORE available but not QRESYNC", () => {
    expect(selectSyncTier({ ...baseCaps, condstore: true })).toBe("condstore");
  });

  test("returns 'full' when neither CONDSTORE nor QRESYNC", () => {
    expect(selectSyncTier(baseCaps)).toBe("full");
  });

  test("QRESYNC takes priority over CONDSTORE", () => {
    const caps = { ...baseCaps, qresync: true, condstore: true, idle: true, move: true };
    expect(selectSyncTier(caps)).toBe("qresync");
  });

  test("additional capabilities don't affect tier selection", () => {
    const caps = { ...baseCaps, idle: true, move: true, uidplus: true, mailboxId: true };
    expect(selectSyncTier(caps)).toBe("full");
  });
});
