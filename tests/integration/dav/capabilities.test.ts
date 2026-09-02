import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import type { DavClient } from "../../../src/dav/client.js";
import { discoverCollections, discoverHomes } from "../../../src/dav/discovery.js";
import { createTestCalendar, sampleEvent, testDavClient } from "../../setup/dav-helpers.js";

/**
 * Hard assertions against the real test Radicale server -- never a self-skip. These are
 * exactly the capabilities the sync engine depends on: `sync-collection` advertised so
 * tier selection can pick the `sync` tier, inline calendar-data in a REPORT response so a
 * backfill is one round trip, and MOVE returning 2xx so a move is one request rather than
 * copy-then-delete.
 */
describe("DAV capabilities: Radicale", () => {
  let client: DavClient;
  let calendarUrl: string;

  beforeAll(async () => {
    client = testDavClient(`caps-${randomUUID().slice(0, 8)}`);
    calendarUrl = await createTestCalendar(client);
  });

  test("current-user-principal and calendar-home-set are discoverable", async () => {
    const homes = await discoverHomes(client);
    expect(homes.principalUrl).toBeTruthy();
    expect(homes.calendarHomeUrl).toBeTruthy();
  });

  test("the created calendar advertises sync-collection in its supported-report-set", async () => {
    const homes = await discoverHomes(client);
    const collections = await discoverCollections(
      client,
      homes.calendarHomeUrl as string,
      "calendar",
    );
    const created = collections.find((c) => c.href === calendarUrl);
    expect(created).toBeDefined();
    expect(created?.supportedReports).toContain("syncCollection");
    expect(created?.tier).toBe("sync");
  });

  test("a sync-collection REPORT with an empty token returns inline calendar-data", async () => {
    const uid = `caps-evt-${randomUUID()}`;
    const put = await client.put(
      new URL(`${uid}.ics`, calendarUrl).toString(),
      sampleEvent(uid),
      "text/calendar; charset=utf-8",
      {
        create: true,
      },
    );
    expect(put.ok).toBe(true);

    const result = await client.syncCollectionReport(calendarUrl, "calendar", "");
    expect(result.tokenInvalid).toBe(false);
    expect(result.syncToken).toBeTruthy();
    const entry = result.entries.find((e) => e.href.includes(uid));
    expect(entry).toBeDefined();
    expect(entry?.data).toContain(`UID:${uid}`);
    expect(entry?.etag).toBeTruthy();
  });

  test("WebDAV MOVE returns a 2xx status, not a 404/501 needing a copy-then-delete fallback", async () => {
    const uid = `caps-move-${randomUUID()}`;
    const sourceUrl = new URL(`${uid}.ics`, calendarUrl).toString();
    const destUrl = new URL(`${uid}-moved.ics`, calendarUrl).toString();
    await client.put(sourceUrl, sampleEvent(uid), "text/calendar; charset=utf-8", { create: true });

    const result = await client.move(sourceUrl, destUrl);
    expect(result.ok).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);

    const etags = await client.listEtags(calendarUrl);
    expect(etags.has(destUrl)).toBe(true);
    expect(etags.has(sourceUrl)).toBe(false);
  });

  test("an unknown sync-token is refused with 403, not silently accepted", async () => {
    const result = await client.syncCollectionReport(
      calendarUrl,
      "calendar",
      "http://radicale.org/ns/sync/this-token-was-never-issued",
    );
    expect(result.tokenInvalid).toBe(true);
  });

  test("a conditional PUT with If-None-Match: * on an existing href is rejected with 412", async () => {
    const uid = `caps-conflict-${randomUUID()}`;
    const url = new URL(`${uid}.ics`, calendarUrl).toString();
    const first = await client.put(url, sampleEvent(uid), "text/calendar; charset=utf-8", {
      create: true,
    });
    expect(first.ok).toBe(true);

    const second = await client.put(
      url,
      sampleEvent(uid, "Different"),
      "text/calendar; charset=utf-8",
      {
        create: true,
      },
    );
    expect(second.status).toBe(412);
  });
});
