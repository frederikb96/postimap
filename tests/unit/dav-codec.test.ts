import { describe, expect, test } from "vitest";
import { parseAddressObject, parseCalendarObject, suggestFilename } from "../../src/dav/codec.js";

function ics(lines: string[]): string {
  return lines.join("\r\n");
}

describe("parseCalendarObject", () => {
  test("parses a simple VEVENT", () => {
    const parsed = parseCalendarObject(
      ics([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        "UID:evt-1",
        "DTSTAMP:20260901T120000Z",
        "DTSTART:20260910T100000Z",
        "DTEND:20260910T110000Z",
        "SUMMARY:Team Meeting",
        "SEQUENCE:2",
        "STATUS:CONFIRMED",
        "ORGANIZER;CN=Alice:mailto:alice@example.com",
        "ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ]),
    );

    expect(parsed.uid).toBe("evt-1");
    expect(parsed.component).toBe("VEVENT");
    expect(parsed.summary).toBe("Team Meeting");
    expect(parsed.dtstart?.toISOString()).toBe("2026-09-10T10:00:00.000Z");
    expect(parsed.dtend?.toISOString()).toBe("2026-09-10T11:00:00.000Z");
    expect(parsed.sequence).toBe(2);
    expect(parsed.status).toBe("CONFIRMED");
    expect(parsed.organizer).toBe("alice@example.com");
    expect(parsed.isRecurring).toBe(false);
    expect(parsed.hasExceptions).toBe(false);
    expect(parsed.allDay).toBe(false);
    expect(parsed.attendees).toEqual([
      {
        email: "bob@example.com",
        cn: "Bob",
        partstat: "NEEDS-ACTION",
        role: "REQ-PARTICIPANT",
        rsvp: true,
      },
    ]);
  });

  test("resolves a TZID-qualified DTSTART against its VTIMEZONE to a real UTC offset", () => {
    const parsed = parseCalendarObject(
      ics([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VTIMEZONE",
        "TZID:Europe/Berlin",
        "BEGIN:DAYLIGHT",
        "TZOFFSETFROM:+0100",
        "TZOFFSETTO:+0200",
        "TZNAME:CEST",
        "DTSTART:19700329T020000",
        "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
        "END:DAYLIGHT",
        "BEGIN:STANDARD",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "TZNAME:CET",
        "DTSTART:19701025T030000",
        "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:evt-tz",
        "DTSTAMP:20260901T120000Z",
        "DTSTART;TZID=Europe/Berlin:20260910T100000",
        "DTEND;TZID=Europe/Berlin:20260910T110000",
        "SUMMARY:Berlin Meeting",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ]),
    );

    // Berlin is UTC+2 in September (CEST) -- 10:00 local is 08:00 UTC.
    expect(parsed.dtstart?.toISOString()).toBe("2026-09-10T08:00:00.000Z");
    expect(parsed.dtstartTz).toBe("Europe/Berlin");
  });

  test("detects a recurring master (RRULE) and its exception (RECURRENCE-ID)", () => {
    const parsed = parseCalendarObject(
      ics([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        "UID:evt-recur",
        "DTSTAMP:20260901T120000Z",
        "DTSTART:20260910T100000Z",
        "DTEND:20260910T110000Z",
        "SUMMARY:Weekly Sync",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:evt-recur",
        "RECURRENCE-ID:20260917T100000Z",
        "DTSTAMP:20260901T120000Z",
        "DTSTART:20260917T130000Z",
        "DTEND:20260917T140000Z",
        "SUMMARY:Weekly Sync (moved)",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ]),
    );

    expect(parsed.isRecurring).toBe(true);
    expect(parsed.hasExceptions).toBe(true);
    // The master (no RECURRENCE-ID) is what the parsed columns describe.
    expect(parsed.summary).toBe("Weekly Sync");
  });

  test("an all-day VALUE=DATE event is flagged all_day", () => {
    const parsed = parseCalendarObject(
      ics([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        "UID:evt-allday",
        "DTSTAMP:20260901T120000Z",
        "DTSTART;VALUE=DATE:20260920",
        "DTEND;VALUE=DATE:20260921",
        "SUMMARY:All day",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ]),
    );
    expect(parsed.allDay).toBe(true);
    expect(parsed.dtstart?.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  test("a VTODO is parsed with component VTODO", () => {
    const parsed = parseCalendarObject(
      ics([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VTODO",
        "UID:todo-1",
        "DTSTAMP:20260901T120000Z",
        "SUMMARY:Buy milk",
        "STATUS:NEEDS-ACTION",
        "END:VTODO",
        "END:VCALENDAR",
        "",
      ]),
    );
    expect(parsed.component).toBe("VTODO");
    expect(parsed.summary).toBe("Buy milk");
    expect(parsed.status).toBe("NEEDS-ACTION");
  });

  test("a METHOD:REQUEST calendar still parses -- stripping it before PUT is the caller's job", () => {
    const parsed = parseCalendarObject(
      ics([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:evt-invite",
        "DTSTAMP:20260901T120000Z",
        "DTSTART:20260910T100000Z",
        "SUMMARY:Invitation",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ]),
    );
    expect(parsed.uid).toBe("evt-invite");
    expect(parsed.summary).toBe("Invitation");
  });

  test("an unparseable body returns every column NULL rather than throwing", () => {
    const parsed = parseCalendarObject("not an ics file at all");
    expect(parsed.uid).toBeNull();
    expect(parsed.component).toBeNull();
    expect(parsed.summary).toBeNull();
  });

  test("a VCALENDAR with no VEVENT/VTODO/VJOURNAL returns every column NULL", () => {
    const parsed = parseCalendarObject(
      ics(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "END:VCALENDAR", ""]),
    );
    expect(parsed.component).toBeNull();
  });
});

describe("parseAddressObject", () => {
  test("parses UID, FN and every EMAIL", () => {
    const parsed = parseAddressObject(
      ics([
        "BEGIN:VCARD",
        "VERSION:3.0",
        "UID:card-1",
        "FN:John Doe",
        "EMAIL;TYPE=WORK:john@example.com",
        "EMAIL;TYPE=HOME:home@example.com",
        "END:VCARD",
        "",
      ]),
    );
    expect(parsed.uid).toBe("card-1");
    expect(parsed.component).toBe("VCARD");
    expect(parsed.summary).toBe("John Doe");
    expect(parsed.emails).toEqual(["john@example.com", "home@example.com"]);
  });

  test("a vCard with no EMAIL leaves emails NULL rather than an empty array", () => {
    const parsed = parseAddressObject(
      ics(["BEGIN:VCARD", "VERSION:4.0", "UID:card-2", "FN:No Email", "END:VCARD", ""]),
    );
    expect(parsed.emails).toBeNull();
  });

  test("an unparseable body returns every column NULL rather than throwing", () => {
    const parsed = parseAddressObject("not a vcard");
    expect(parsed.uid).toBeNull();
    expect(parsed.emails).toBeNull();
  });
});

describe("suggestFilename", () => {
  test("builds a filename from the UID with the kind's extension", () => {
    expect(suggestFilename("evt-1", "calendar")).toBe("evt-1.ics");
    expect(suggestFilename("card-1", "addressbook")).toBe("card-1.vcf");
  });

  test("sanitizes characters a filesystem/URL path would not accept", () => {
    expect(suggestFilename("evt with spaces/slash", "calendar")).toBe("evt_with_spaces_slash.ics");
  });

  test("falls back to a random name when there is no UID", () => {
    const a = suggestFilename(null, "calendar");
    const b = suggestFilename(null, "calendar");
    expect(a).toMatch(/\.ics$/);
    expect(a).not.toBe(b);
  });
});
