import { describe, expect, test } from "vitest";
import {
  markCondstoreUnreliable,
  type ServerCapabilities,
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

  test("picks 'full' once condstoreUnreliable is set, even with qresync/condstore both true", () => {
    const caps = { ...baseCaps, qresync: true, condstore: true, condstoreUnreliable: true };
    expect(selectSyncTier(caps)).toBe("full");
  });
});

describe("markCondstoreUnreliable", () => {
  const baseCaps: ServerCapabilities = {
    condstore: true,
    qresync: true,
    idle: true,
    move: true,
    uidplus: true,
    mailboxId: true,
  };

  test("forces condstore and qresync off and sets the sticky marker", () => {
    const caps = { ...baseCaps };
    markCondstoreUnreliable(caps);
    expect(caps.condstoreUnreliable).toBe(true);
    expect(caps.condstore).toBe(false);
    expect(caps.qresync).toBe(false);
  });

  test("leaves unrelated capabilities untouched", () => {
    const caps = { ...baseCaps };
    markCondstoreUnreliable(caps);
    expect(caps.idle).toBe(true);
    expect(caps.move).toBe(true);
    expect(caps.uidplus).toBe(true);
    expect(caps.mailboxId).toBe(true);
  });

  test("the result always selects the full-diff tier", () => {
    const caps = { ...baseCaps };
    markCondstoreUnreliable(caps);
    expect(selectSyncTier(caps)).toBe("full");
  });
});
