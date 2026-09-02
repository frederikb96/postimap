import { randomUUID } from "node:crypto";
import { DavClient } from "../../src/dav/client.js";
import { env, getRadicaleUrl } from "./env.js";

/**
 * A DavClient against the test Radicale container. Each test picks its own username --
 * Radicale's `auth.type = none` accepts any Basic auth and auto-creates the principal (and
 * therefore an isolated set of collections) on first request, so a unique username is all
 * the isolation a test needs, the same role a unique mailbox plays on the IMAP side.
 */
export function testDavClient(username = `dav-${randomUUID().slice(0, 8)}`): DavClient {
  return new DavClient({
    baseUrl: getRadicaleUrl(),
    username,
    password: env.DAV_PASSWORD,
    tlsRejectUnauthorized: true,
    requestTimeoutMs: 10_000,
  });
}

/** Discover the calendar home for a fresh principal and create one calendar under it. */
export async function createTestCalendar(
  client: DavClient,
  slug = `cal-${randomUUID().slice(0, 8)}`,
  displayName = "Test Calendar",
): Promise<string> {
  const principal = await client.currentUserPrincipal();
  if (!principal) throw new Error("Could not discover current-user-principal");
  const { calendarHome } = await client.homeSets(principal);
  if (!calendarHome) throw new Error("Could not discover calendar-home-set");
  const url = new URL(`${slug}/`, calendarHome).toString();
  const result = await client.mkcalendar(url, displayName);
  if (!result.ok) throw new Error(`MKCALENDAR failed with HTTP ${result.status}`);
  return url;
}

export async function createTestAddressbook(
  client: DavClient,
  slug = `ab-${randomUUID().slice(0, 8)}`,
  displayName = "Test Addressbook",
): Promise<string> {
  const principal = await client.currentUserPrincipal();
  if (!principal) throw new Error("Could not discover current-user-principal");
  const { addressbookHome } = await client.homeSets(principal);
  if (!addressbookHome) throw new Error("Could not discover addressbook-home-set");
  const url = new URL(`${slug}/`, addressbookHome).toString();
  const result = await client.mkAddressbook(url, displayName);
  if (!result.ok) throw new Error(`MKCOL failed with HTTP ${result.status}`);
  return url;
}

export function sampleEvent(uid: string, summary = "Sample Event"): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//postimap-test//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T120000Z",
    "DTSTART:20260910T100000Z",
    "DTEND:20260910T110000Z",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export function sampleContact(
  uid: string,
  fn = "Sample Contact",
  email = "sample@example.com",
): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${uid}`,
    `FN:${fn}`,
    `EMAIL:${email}`,
    "END:VCARD",
    "",
  ].join("\r\n");
}
