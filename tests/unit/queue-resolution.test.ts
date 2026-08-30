import { describe, expect, test } from "vitest";
import { type ResolvableEntry, resolveTarget } from "../../src/sync/queue-resolution.js";

const FROM = "11111111-1111-1111-1111-111111111111";
const TO = "22222222-2222-2222-2222-222222222222";

function entry(overrides: Partial<ResolvableEntry> & { action: string }): ResolvableEntry {
  return {
    payload: {},
    folder_id: null,
    imap_uid: null,
    ...overrides,
  };
}

describe("resolveTarget", () => {
  test("a move reads its coordinates from the payload, never from the row", () => {
    // The row's folder_id is already the destination the app wrote and its imap_uid is
    // the NULL written with it, so neither describes where the message physically is.
    const result = resolveTarget(
      entry({
        action: "move",
        folder_id: TO,
        imap_uid: null,
        payload: { from_folder_id: FROM, to_folder_id: TO, old_imap_uid: "42" },
      }),
    );

    expect(result).toEqual({
      resolved: true,
      sourceFolderId: FROM,
      targetFolderId: TO,
      sourceUid: 42,
    });
  });

  test("a move whose payload lost its source UID falls back to the live column", () => {
    // The trigger fired on an already-nulled row -- an earlier hop of the same chain was
    // claimed in a different batch. That hop wrote the server's UID back, and it is the
    // UID in from_folder_id, which is exactly what this move has to name.
    const result = resolveTarget(
      entry({
        action: "move",
        imap_uid: "77",
        payload: { from_folder_id: FROM, to_folder_id: TO, old_imap_uid: null },
      }),
    );

    expect(result).toMatchObject({ resolved: true, sourceUid: 77, sourceFolderId: FROM });
  });

  test("a move with neither source names what is missing rather than failing vaguely", () => {
    const result = resolveTarget(
      entry({ action: "move", payload: { from_folder_id: FROM, to_folder_id: TO } }),
    );

    expect(result).toEqual({ resolved: false, unresolved: "Cannot resolve source imap_uid" });
  });

  test("a delete prefers the coordinates a superseded move handed it", () => {
    const result = resolveTarget(
      entry({
        action: "delete",
        folder_id: TO,
        imap_uid: "99",
        payload: { folder_id: FROM, imap_uid: "42" },
      }),
    );

    expect(result).toMatchObject({ resolved: true, sourceFolderId: FROM, sourceUid: 42 });
  });

  test("a plain delete falls back to the row", () => {
    const result = resolveTarget(entry({ action: "delete", folder_id: FROM, imap_uid: "42" }));

    expect(result).toMatchObject({ resolved: true, sourceFolderId: FROM, sourceUid: 42 });
  });

  test("a flag change acts where the message is now, on the UID it has now", () => {
    const result = resolveTarget(
      entry({ action: "flag_add", folder_id: TO, imap_uid: "8", payload: { flag: "\\Seen" } }),
    );

    expect(result).toEqual({
      resolved: true,
      sourceFolderId: TO,
      targetFolderId: null,
      sourceUid: 8,
    });
  });

  test("a flag change with no UID yet is unresolved, not silently applied to nothing", () => {
    const result = resolveTarget(
      entry({ action: "flag_add", folder_id: TO, payload: { flag: "\\Seen" } }),
    );

    expect(result).toEqual({ resolved: false, unresolved: "Cannot resolve imap_uid" });
  });

  test("every missing piece is named, not just the first", () => {
    const result = resolveTarget(entry({ action: "flag_remove", payload: { flag: "\\Seen" } }));

    expect(result).toEqual({ resolved: false, unresolved: "Cannot resolve folder and imap_uid" });
  });
});
