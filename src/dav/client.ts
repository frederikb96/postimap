import {
  createObject,
  type DAVResponse,
  davRequest,
  deleteObject,
  propfind,
  syncCollection,
  updateObject,
} from "tsdav";
import { createLogger } from "../util/logger.js";

const log = createLogger("dav-client");

export interface DavClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  tlsRejectUnauthorized: boolean;
  requestTimeoutMs: number;
}

/** A prop tree the way tsdav expects it: element name -> nested prop tree (or {} for a leaf). */
export type PropTree = Record<string, unknown>;

export interface CollectionEntry {
  href: string;
  resourcetype: string[];
  displayName: string | null;
  syncToken: string | null;
  ctag: string | null;
  supportedReports: string[];
  privileges: string[];
  supportedComponents: string[];
  color: string | null;
}

export interface SyncCollectionEntry {
  href: string;
  status: number;
  etag: string | null;
  data: string | null;
}

export interface SyncCollectionResult {
  entries: SyncCollectionEntry[];
  syncToken: string | null;
  /** True on a 403 valid-sync-token response -- the stored token is no longer accepted. */
  tokenInvalid: boolean;
}

/**
 * Thin layer over tsdav's request-level API (`propfind`, `davRequest`, `syncCollection`,
 * `createObject`/`updateObject`/`deleteObject`). Deliberately not tsdav's `DAVClient` /
 * `createAccount` / `fetchCalendars` convenience layer -- that path does a second multiget
 * unconditionally and hides exactly the low-level control this module needs (inline
 * sync-collection data, MOVE, MKCALENDAR, extended MKCOL, PROPPATCH).
 */
export class DavClient {
  private readonly headers: Record<string, string>;

  constructor(private options: DavClientOptions) {
    const basic = Buffer.from(`${options.username}:${options.password}`).toString("base64");
    this.headers = { Authorization: `Basic ${basic}` };
    if (!options.tlsRejectUnauthorized && options.baseUrl.startsWith("https:")) {
      // tsdav has no per-request rejectUnauthorized option -- Node's fetch (undici) only
      // honours this process-wide, the same limitation the IMAP side works around by
      // setting POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED for its own TLS library. A false
      // value here is a dev/test escape hatch for a self-signed server, never meant for
      // more than one account in a process at a time.
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      log.warn(
        "dav.tls_reject_unauthorized = false set process-wide via NODE_TLS_REJECT_UNAUTHORIZED",
      );
    }
  }

  resolve(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }

  /** PROPFIND at `url`. `depth` is "0" for the resource itself, "1" for its direct children. */
  async propfind(url: string, props: PropTree, depth: "0" | "1"): Promise<DAVResponse[]> {
    return propfind({ url, props, depth, headers: this.headers });
  }

  /** current-user-principal, resolved to an absolute URL. */
  async currentUserPrincipal(): Promise<string | null> {
    const res = await this.propfind(this.options.baseUrl, { "d:current-user-principal": {} }, "0");
    const href = extractHref(res[0]?.props, "currentUserPrincipal");
    return href ? this.resolve(href) : null;
  }

  /** calendar-home-set and addressbook-home-set off the principal URL. */
  async homeSets(
    principalUrl: string,
  ): Promise<{ calendarHome: string | null; addressbookHome: string | null }> {
    const res = await this.propfind(
      principalUrl,
      { "c:calendar-home-set": {}, "card:addressbook-home-set": {} },
      "0",
    );
    const props = res[0]?.props as Record<string, unknown> | undefined;
    const calHref = extractHref(props, "calendarHomeSet");
    const abHref = extractHref(props, "addressbookHomeSet");
    return {
      calendarHome: calHref ? this.resolve(calHref) : null,
      addressbookHome: abHref ? this.resolve(abHref) : null,
    };
  }

  /**
   * Depth-1 listing of a home collection, filtered to actual calendars/addressbooks --
   * the home itself, and Nextcloud's schedule-inbox/outbox/trashbin and system address
   * book, are excluded by the caller via `resourcetype`.
   */
  async listCollections(
    homeUrl: string,
    kind: "calendar" | "addressbook",
  ): Promise<CollectionEntry[]> {
    const res = await this.propfind(
      homeUrl,
      {
        "d:resourcetype": {},
        "d:displayname": {},
        "d:sync-token": {},
        "cs:getctag": {},
        "d:current-user-privilege-set": {},
        "d:supported-report-set": {},
        "c:supported-calendar-component-set": {},
        "ca:calendar-color": {},
      },
      "1",
    );

    const marker = kind === "calendar" ? "calendar" : "addressbook";
    const entries: CollectionEntry[] = [];
    for (const r of res) {
      if (!r.ok) continue;
      const props = r.props as Record<string, unknown>;
      const resourcetype = Object.keys((props.resourcetype as Record<string, unknown>) ?? {});
      if (!resourcetype.includes(marker)) continue;
      if (hrefOf(r) === homeUrl || stripTrailingSlash(hrefOf(r)) === stripTrailingSlash(homeUrl))
        continue;

      entries.push({
        href: this.resolve(hrefOf(r)),
        resourcetype,
        displayName: typeof props.displayname === "string" ? props.displayname : null,
        syncToken: typeof props.syncToken === "string" ? props.syncToken : null,
        ctag: typeof props.getctag === "string" ? props.getctag : null,
        supportedReports: extractReportNames(props.supportedReportSet),
        privileges: extractPrivilegeNames(props.currentUserPrivilegeSet),
        supportedComponents: extractComponentNames(props.supportedCalendarComponentSet),
        color: typeof props.calendarColor === "string" ? props.calendarColor : null,
      });
    }
    return entries;
  }

  /** REPORT sync-collection with inline data. Empty `syncToken` returns the full state. */
  async syncCollectionReport(
    collectionUrl: string,
    kind: "calendar" | "addressbook",
    syncToken: string,
  ): Promise<SyncCollectionResult> {
    const dataProp = kind === "calendar" ? "c:calendar-data" : "card:address-data";
    const res = await syncCollection({
      url: collectionUrl,
      props: { "d:getetag": {}, [dataProp]: {} },
      syncLevel: 1,
      syncToken,
      headers: this.headers,
    });

    if (res.length === 1 && res[0].status === 403) {
      return { entries: [], syncToken: null, tokenInvalid: true };
    }

    const entries: SyncCollectionEntry[] = [];
    let token: string | null = null;
    for (const r of res) {
      const raw = r.raw as { multistatus?: { syncToken?: string } } | undefined;
      const t = raw?.multistatus?.syncToken;
      if (typeof t === "string") token = t;

      if (
        hrefOf(r) === collectionUrl ||
        stripTrailingSlash(hrefOf(r)) === stripTrailingSlash(collectionUrl)
      ) {
        continue;
      }
      const props = r.props as Record<string, unknown> | undefined;
      const etag = typeof props?.getetag === "string" ? props.getetag : null;
      const data =
        typeof props?.calendarData === "string"
          ? props.calendarData
          : typeof props?.addressData === "string"
            ? props.addressData
            : null;
      entries.push({ href: this.resolve(hrefOf(r)), status: r.status, etag, data });
    }

    return { entries, syncToken: token, tokenInvalid: false };
  }

  /** PROPFIND getetag over every live member of a collection -- the ctag/full tier's diff. */
  async listEtags(collectionUrl: string): Promise<Map<string, string>> {
    const res = await this.propfind(collectionUrl, { "d:getetag": {} }, "1");
    const out = new Map<string, string>();
    for (const r of res) {
      if (!r.ok) continue;
      if (stripTrailingSlash(hrefOf(r)) === stripTrailingSlash(collectionUrl)) continue;
      const etag = (r.props as Record<string, unknown> | undefined)?.getetag;
      if (typeof etag === "string") out.set(this.resolve(hrefOf(r)), etag);
    }
    return out;
  }

  /** calendar-multiget / addressbook-multiget REPORT, chunked by the caller. */
  async multiget(
    collectionUrl: string,
    hrefs: string[],
    kind: "calendar" | "addressbook",
  ): Promise<SyncCollectionEntry[]> {
    if (hrefs.length === 0) return [];
    const reportName = kind === "calendar" ? "c:calendar-multiget" : "card:addressbook-multiget";
    const dataProp = kind === "calendar" ? "c:calendar-data" : "card:address-data";
    const res = await davRequest({
      url: collectionUrl,
      init: {
        method: "REPORT",
        namespace: "d",
        headers: this.headers,
        body: {
          [reportName]: {
            _attributes: {
              "xmlns:d": "DAV:",
              "xmlns:c": "urn:ietf:params:xml:ns:caldav",
              "xmlns:card": "urn:ietf:params:xml:ns:carddav",
            },
            prop: { "d:getetag": {}, [dataProp]: {} },
            href: hrefs.map((h) => new URL(h).pathname),
          },
        },
      },
    });

    return res
      .filter((r) => stripTrailingSlash(hrefOf(r)) !== stripTrailingSlash(collectionUrl))
      .map((r) => {
        const props = r.props as Record<string, unknown> | undefined;
        const etag = typeof props?.getetag === "string" ? props.getetag : null;
        const data =
          typeof props?.calendarData === "string"
            ? props.calendarData
            : typeof props?.addressData === "string"
              ? props.addressData
              : null;
        return { href: this.resolve(hrefOf(r)), status: r.status, etag, data };
      });
  }

  /** PUT a resource. `ifMatch` for an update, `create: true` for If-None-Match: *. */
  async put(
    url: string,
    data: string,
    contentType: string,
    opts: { ifMatch?: string; create?: boolean },
  ): Promise<{ ok: boolean; status: number; etag: string | null }> {
    let res: Response;
    if (opts.create) {
      res = await createObject({
        url,
        data,
        headers: { ...this.headers, "Content-Type": contentType, "If-None-Match": "*" },
      });
    } else {
      res = await updateObject({
        url,
        data,
        etag: opts.ifMatch,
        headers: { ...this.headers, "Content-Type": contentType },
      });
    }
    return { ok: res.ok, status: res.status, etag: res.headers.get("etag") };
  }

  async delete(url: string, ifMatch?: string): Promise<{ ok: boolean; status: number }> {
    const res = await deleteObject({
      url,
      etag: ifMatch,
      headers: this.headers,
    });
    return { ok: res.ok, status: res.status };
  }

  /** WebDAV MOVE. Returns the status so the caller can fall back to PUT+DELETE on 405/501. */
  async move(url: string, destinationUrl: string): Promise<{ ok: boolean; status: number }> {
    const res = await davRequest({
      url,
      init: {
        method: "MOVE",
        headers: { ...this.headers, Destination: destinationUrl },
        body: undefined,
      },
    });
    const first = res[0];
    return { ok: first?.ok ?? false, status: first?.status ?? 0 };
  }

  async mkcalendar(url: string, displayName: string): Promise<{ ok: boolean; status: number }> {
    const res = await davRequest({
      url,
      init: {
        method: "MKCALENDAR",
        namespace: "c",
        headers: this.headers,
        body: {
          mkcalendar: {
            _attributes: { "xmlns:d": "DAV:", "xmlns:c": "urn:ietf:params:xml:ns:caldav" },
            set: { prop: { "d:displayname": displayName } },
          },
        },
      },
    });
    const first = res[0];
    return { ok: first?.ok ?? false, status: first?.status ?? 0 };
  }

  async mkAddressbook(url: string, displayName: string): Promise<{ ok: boolean; status: number }> {
    const res = await davRequest({
      url,
      init: {
        method: "MKCOL",
        namespace: "d",
        headers: this.headers,
        body: {
          mkcol: {
            _attributes: { "xmlns:d": "DAV:", "xmlns:card": "urn:ietf:params:xml:ns:carddav" },
            set: {
              prop: {
                "d:resourcetype": { collection: {}, "card:addressbook": {} },
                "d:displayname": displayName,
              },
            },
          },
        },
      },
    });
    const first = res[0];
    return { ok: first?.ok ?? false, status: first?.status ?? 0 };
  }

  async proppatch(
    url: string,
    props: { displayName?: string | null; color?: string | null },
  ): Promise<{ ok: boolean; status: number }> {
    const prop: PropTree = {};
    if (props.displayName != null) prop["d:displayname"] = props.displayName;
    if (props.color != null) prop["ical:calendar-color"] = props.color;
    if (Object.keys(prop).length === 0) return { ok: true, status: 200 };

    const res = await davRequest({
      url,
      init: {
        method: "PROPPATCH",
        namespace: "d",
        headers: this.headers,
        body: {
          propertyupdate: {
            _attributes: { "xmlns:d": "DAV:", "xmlns:ical": "http://apple.com/ns/ical/" },
            set: { prop },
          },
        },
      },
    });
    const first = res[0];
    return { ok: first?.ok ?? false, status: first?.status ?? 0 };
  }

  async removeCollection(url: string): Promise<{ ok: boolean; status: number }> {
    const res = await davRequest({
      url,
      init: { method: "DELETE", headers: this.headers, body: undefined },
    });
    const first = res[0];
    return { ok: first?.ok ?? false, status: first?.status ?? 0 };
  }
}

function hrefOf(r: { href?: string }): string {
  return r.href ?? "";
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function extractHref(props: unknown, key: string): string | null {
  if (typeof props !== "object" || props === null) return null;
  const val = (props as Record<string, unknown>)[key];
  if (typeof val === "object" && val !== null && "href" in val) {
    const href = (val as { href?: unknown }).href;
    return typeof href === "string" ? href : null;
  }
  return null;
}

function extractReportNames(supportedReportSet: unknown): string[] {
  const set = supportedReportSet as { supportedReport?: unknown } | undefined;
  const list = toArray(set?.supportedReport);
  const names: string[] = [];
  for (const entry of list) {
    const report = (entry as { report?: Record<string, unknown> })?.report;
    if (report) names.push(...Object.keys(report));
  }
  return names;
}

function extractPrivilegeNames(privilegeSet: unknown): string[] {
  const set = privilegeSet as { privilege?: unknown } | undefined;
  const list = toArray(set?.privilege);
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry === "object" && entry !== null) names.push(...Object.keys(entry));
  }
  return names;
}

function extractComponentNames(componentSet: unknown): string[] {
  const set = componentSet as { comp?: unknown } | undefined;
  const list = toArray(set?.comp);
  const names: string[] = [];
  for (const entry of list) {
    const name = (entry as { _attributes?: { name?: string } })?._attributes?.name;
    if (name) names.push(name);
  }
  return names;
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}
