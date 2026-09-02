import ICAL from "ical.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("dav-codec");

export interface Attendee {
  email: string;
  cn: string | null;
  partstat: string | null;
  role: string | null;
  rsvp: boolean | null;
}

/** The PostIMAP-managed columns derived from `dav_objects.data`. Never written back into it. */
export interface ParsedDavObject {
  uid: string | null;
  component: "VEVENT" | "VTODO" | "VJOURNAL" | "VCARD" | null;
  summary: string | null;
  dtstart: Date | null;
  dtend: Date | null;
  dtstartTz: string | null;
  allDay: boolean;
  isRecurring: boolean;
  hasExceptions: boolean;
  status: string | null;
  sequence: number | null;
  organizer: string | null;
  attendees: Attendee[] | null;
  emails: string[] | null;
  lastModified: Date | null;
}

const EMPTY: ParsedDavObject = {
  uid: null,
  component: null,
  summary: null,
  dtstart: null,
  dtend: null,
  dtstartTz: null,
  allDay: false,
  isRecurring: false,
  hasExceptions: false,
  status: null,
  sequence: null,
  organizer: null,
  attendees: null,
  emails: null,
  lastModified: null,
};

/** Registers any VTIMEZONE subcomponents so TZID-referenced dates resolve to real offsets. */
function registerTimezones(root: ICAL.Component): void {
  for (const vt of root.getAllSubcomponents("vtimezone")) {
    try {
      const tz = new ICAL.Timezone(vt);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) {
        ICAL.TimezoneService.register(tz, tz.tzid);
      }
    } catch (err) {
      log.warn({ err }, "Failed to register a VTIMEZONE component");
    }
  }
}

/** getFirstPropertyValue returns a broad union across every iCal value type; narrow it. */
function asString(val: unknown): string | null {
  return typeof val === "string" ? val : null;
}

function asNumber(val: unknown): number | null {
  if (typeof val === "number") return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function toDate(t: ICAL.Time | null | undefined): Date | null {
  if (!t) return null;
  try {
    return t.toJSDate();
  } catch {
    return null;
  }
}

function attendeesFrom(comp: ICAL.Component): Attendee[] | null {
  const props = comp.getAllProperties("attendee");
  if (props.length === 0) return null;
  return props.map((p) => {
    const value = String(p.getFirstValue() ?? "");
    const rsvp = p.getParameter("rsvp") as string | undefined;
    return {
      email: value.replace(/^mailto:/i, ""),
      cn: (p.getParameter("cn") as string | undefined) ?? null,
      partstat: (p.getParameter("partstat") as string | undefined) ?? null,
      role: (p.getParameter("role") as string | undefined) ?? null,
      rsvp: rsvp === undefined ? null : rsvp.toUpperCase() === "TRUE",
    };
  });
}

/**
 * Parse a VCALENDAR resource (one VEVENT/VTODO/VJOURNAL master, plus any RECURRENCE-ID
 * exceptions of the same UID). The master is the component with no RECURRENCE-ID; if none
 * has one, the first component wins. A malformed object never throws -- an unparseable
 * calendar object gets every column NULL rather than aborting the sync cycle it arrived in.
 */
export function parseCalendarObject(data: string): ParsedDavObject {
  try {
    const jcal = ICAL.parse(data);
    const root = new ICAL.Component(jcal);
    registerTimezones(root);

    const kinds: Array<"vevent" | "vtodo" | "vjournal"> = ["vevent", "vtodo", "vjournal"];
    let components: ICAL.Component[] = [];
    let componentName: "VEVENT" | "VTODO" | "VJOURNAL" | null = null;
    for (const kind of kinds) {
      const found = root.getAllSubcomponents(kind);
      if (found.length > 0) {
        components = found;
        componentName = kind.toUpperCase() as "VEVENT" | "VTODO" | "VJOURNAL";
        break;
      }
    }
    if (components.length === 0 || !componentName) {
      log.warn("Calendar object has no VEVENT/VTODO/VJOURNAL component");
      return EMPTY;
    }

    const master = components.find((c) => !c.getFirstProperty("recurrence-id")) ?? components[0];
    const hasExceptions = components.length > 1;
    const isRecurring = Boolean(
      master.getFirstProperty("rrule") || master.getFirstProperty("rdate"),
    );

    const dtstartProp = master.getFirstProperty("dtstart");
    const dtstart = dtstartProp?.getFirstValue() as ICAL.Time | undefined;
    const dtendProp = master.getFirstProperty("dtend");
    const dtend = dtendProp?.getFirstValue() as ICAL.Time | undefined;

    const organizerProp = master.getFirstProperty("organizer");
    const organizerValue = organizerProp
      ? String(organizerProp.getFirstValue() ?? "").replace(/^mailto:/i, "")
      : null;

    const lastModProp = master.getFirstProperty("last-modified");
    const lastModified = lastModProp ? toDate(lastModProp.getFirstValue() as ICAL.Time) : null;

    return {
      uid: asString(master.getFirstPropertyValue("uid")),
      component: componentName,
      summary: asString(master.getFirstPropertyValue("summary")),
      dtstart: toDate(dtstart),
      dtend: toDate(dtend),
      dtstartTz:
        dtstart?.zone && dtstart.zone !== ICAL.Timezone.utcTimezone ? dtstart.zone.tzid : null,
      allDay: dtstart?.isDate ?? false,
      isRecurring,
      hasExceptions,
      status: asString(master.getFirstPropertyValue("status")),
      sequence: asNumber(master.getFirstPropertyValue("sequence")),
      organizer: organizerValue,
      attendees: attendeesFrom(master),
      emails: null,
      lastModified,
    };
  } catch (err) {
    log.warn({ err }, "Failed to parse a calendar object");
    return EMPTY;
  }
}

/** Parse a VCARD resource. */
export function parseAddressObject(data: string): ParsedDavObject {
  try {
    const jcal = ICAL.parse(data);
    const comp = new ICAL.Component(jcal);
    const emails = comp
      .getAllProperties("email")
      .map((p) => String(p.getFirstValue() ?? ""))
      .filter((e) => e.length > 0);
    const revProp = comp.getFirstProperty("rev");
    const lastModified = revProp ? toDate(revProp.getFirstValue() as ICAL.Time) : null;

    return {
      ...EMPTY,
      uid: asString(comp.getFirstPropertyValue("uid")),
      component: "VCARD",
      summary: asString(comp.getFirstPropertyValue("fn")),
      emails: emails.length > 0 ? emails : null,
      lastModified,
    };
  } catch (err) {
    log.warn({ err }, "Failed to parse an address object");
    return EMPTY;
  }
}

export function parseObject(data: string, kind: "calendar" | "addressbook"): ParsedDavObject {
  return kind === "calendar" ? parseCalendarObject(data) : parseAddressObject(data);
}

/** A filesystem-safe href filename from a parsed UID, falling back to a random one. */
export function suggestFilename(uid: string | null, kind: "calendar" | "addressbook"): string {
  const ext = kind === "calendar" ? "ics" : "vcf";
  const base = uid ? uid.replace(/[^A-Za-z0-9._-]/g, "_") : crypto.randomUUID();
  return `${base}.${ext}`;
}
