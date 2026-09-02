import { beforeEach, describe, expect, test, vi } from "vitest";

const syncCollectionMock = vi.fn();

vi.mock("tsdav", () => ({
  syncCollection: (...args: unknown[]) => syncCollectionMock(...args),
  propfind: vi.fn(),
  davRequest: vi.fn(),
  createObject: vi.fn(),
  updateObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { DavClient } = await import("../../src/dav/client.js");

function client() {
  return new DavClient({
    baseUrl: "https://cloud.example.com/remote.php/dav/",
    username: "u",
    password: "p",
    tlsRejectUnauthorized: true,
    requestTimeoutMs: 5_000,
  });
}

const collectionUrl = "https://cloud.example.com/remote.php/dav/calendars/u/empty-cal/";

beforeEach(() => {
  syncCollectionMock.mockReset();
});

describe("DavClient.syncCollectionReport", () => {
  test("an empty Nextcloud collection's spurious hrefless response element is not treated as a changed resource", async () => {
    // The exact shape a fresh empty Nextcloud collection sends back for an empty-token
    // sync-collection REPORT: one multistatus <response> with no <href> child at all,
    // which tsdav's xml2js layer parses as `href: undefined` rather than an empty string.
    const raw = { multistatus: { syncToken: "https://cloud.example.com/dav/ns/sync/3" } };
    syncCollectionMock.mockResolvedValue([
      { raw, href: undefined, status: 200, statusText: "OK", ok: true, props: {} },
    ]);

    const result = await client().syncCollectionReport(collectionUrl, "calendar", "", false);

    expect(result.entries).toEqual([]);
    expect(result.tokenInvalid).toBe(false);
  });

  test("the sync token is still captured from that same response, so the collection finishes with a usable token", async () => {
    const raw = { multistatus: { syncToken: "https://cloud.example.com/dav/ns/sync/3" } };
    syncCollectionMock.mockResolvedValue([
      { raw, href: undefined, status: 200, statusText: "OK", ok: true, props: {} },
    ]);

    const result = await client().syncCollectionReport(collectionUrl, "calendar", "", false);

    expect(result.syncToken).toBe("https://cloud.example.com/dav/ns/sync/3");
  });

  test("a genuine self-entry describing the collection is still excluded", async () => {
    const raw = { multistatus: { syncToken: "https://cloud.example.com/dav/ns/sync/1" } };
    syncCollectionMock.mockResolvedValue([
      {
        raw,
        href: "/remote.php/dav/calendars/u/empty-cal/",
        status: 200,
        statusText: "OK",
        ok: true,
        props: {},
      },
    ]);

    const result = await client().syncCollectionReport(collectionUrl, "calendar", "", false);

    expect(result.entries).toEqual([]);
  });

  test("a real changed member with an href is still reported", async () => {
    const raw = { multistatus: { syncToken: "https://cloud.example.com/dav/ns/sync/4" } };
    syncCollectionMock.mockResolvedValue([
      {
        raw,
        href: "/remote.php/dav/calendars/u/empty-cal/event-1.ics",
        status: 200,
        statusText: "OK",
        ok: true,
        props: { getetag: '"abc123"', calendarData: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" },
      },
    ]);

    const result = await client().syncCollectionReport(collectionUrl, "calendar", "", true);

    expect(result.entries).toEqual([
      {
        href: "https://cloud.example.com/remote.php/dav/calendars/u/empty-cal/event-1.ics",
        status: 200,
        etag: '"abc123"',
        data: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      },
    ]);
  });

  test("a stored token Nextcloud no longer accepts is still reported as invalid", async () => {
    syncCollectionMock.mockResolvedValue([{ status: 403, statusText: "Forbidden", ok: false }]);

    const result = await client().syncCollectionReport(collectionUrl, "calendar", "stale-token");

    expect(result.tokenInvalid).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.syncToken).toBeNull();
  });
});
