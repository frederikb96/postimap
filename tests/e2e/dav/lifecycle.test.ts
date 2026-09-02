import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DavAccountSync } from "../../../src/dav/account-sync.js";
import { DavClient } from "../../../src/dav/client.js";
import { DavOutboundProcessor } from "../../../src/dav/outbound.js";
import {
  type DavE2EContext,
  setupDavE2EContext,
  teardownDavE2EContext,
} from "../../setup/dav-e2e-helpers.js";
import {
  createTestAddressbook,
  createTestCalendar,
  sampleContact,
  sampleEvent,
} from "../../setup/dav-helpers.js";
import { env, getRadicaleUrl } from "../../setup/env.js";
import { waitFor } from "../../setup/wait-for.js";

interface DavEvent {
  type: string;
  op: string;
  id: string;
  account_id?: string;
  collection_id?: string;
  origin?: string;
  backfill?: boolean;
  changed?: string[];
}

let ctx: DavE2EContext;
let client: DavClient;
let outbound: DavOutboundProcessor;
let accountSync: DavAccountSync;
let calendarUrl: string;
let addressbookUrl: string;
let events: DavEvent[] = [];
let subscription: { unlisten: () => Promise<void> } | undefined;

const config = {
  POLL_SECONDS: 3600,
  FULL_RECONCILE_SECONDS: 3600,
  TLS_REJECT_UNAUTHORIZED: true,
  REQUEST_TIMEOUT_SECONDS: 10,
  MULTIGET_CHUNK: 2,
};

function eventsOf(type: string): DavEvent[] {
  return events.filter((e) => e.type === type && e.account_id === ctx.davAccountId);
}

/**
 * The real account lifecycle -- DavAccountSync.start() against a principal that already
 * holds a calendar with events and an address book with a contact, the way an account
 * added to a running PostIMAP finds its server.
 */
beforeAll(async () => {
  ctx = await setupDavE2EContext("e2e-dav-lifecycle");
  client = new DavClient({
    baseUrl: getRadicaleUrl(),
    username: ctx.davUsername,
    password: env.DAV_PASSWORD,
    tlsRejectUnauthorized: true,
    requestTimeoutMs: 10_000,
  });
  calendarUrl = await createTestCalendar(client, "existing", "Existing Calendar");
  addressbookUrl = await createTestAddressbook(client, "people", "People");
  for (const n of [1, 2, 3]) {
    const uid = `pre-${n}-${randomUUID()}`;
    await client.put(
      new URL(`${uid}.ics`, calendarUrl).toString(),
      sampleEvent(uid, `Pre-existing ${n}`),
      "text/calendar; charset=utf-8",
      { create: true },
    );
  }
  const contactUid = `contact-${randomUUID()}`;
  await client.put(
    new URL(`${contactUid}.vcf`, addressbookUrl).toString(),
    sampleContact(contactUid, "Ada Lovelace", "ada@example.com"),
    "text/vcard; charset=utf-8",
    { create: true },
  );

  subscription = await ctx.pgSql.listen("postimap_events", (payload) => {
    events.push(JSON.parse(payload) as DavEvent);
  });

  outbound = new DavOutboundProcessor(ctx.db, ctx.databaseUrl, () => client, 60_000);
  await outbound.start();
  accountSync = new DavAccountSync(ctx.davAccountId, ctx.db, config, outbound);
});

afterAll(async () => {
  await accountSync?.stop();
  await outbound?.stop();
  await subscription?.unlisten();
  await teardownDavE2EContext(ctx);
});

describe("E2E: DAV account lifecycle", () => {
  test("start() discovers the homes, backfills every collection and reaches active", async () => {
    await accountSync.start();
    expect(accountSync.getState()).toBe("active");

    const account = await ctx.db
      .selectFrom("dav_accounts")
      .select([
        "state",
        "principal_url",
        "calendar_home_url",
        "addressbook_home_url",
        "last_polled_at",
        "error_count",
      ])
      .where("id", "=", ctx.davAccountId)
      .executeTakeFirstOrThrow();
    expect(account.state).toBe("active");
    expect(account.principal_url).toBeTruthy();
    expect(account.calendar_home_url).toBeTruthy();
    expect(account.addressbook_home_url).toBeTruthy();
    expect(account.last_polled_at).not.toBeNull();
    expect(account.error_count).toBe(0);

    const collections = await ctx.db
      .selectFrom("dav_collections")
      .select([
        "href",
        "kind",
        "sync_tier",
        "initial_sync_done",
        "backfill_total",
        "total_count",
        "sync_token",
      ])
      .where("account_id", "=", ctx.davAccountId)
      .execute();
    const calendar = collections.find((c) => c.href === calendarUrl);
    const addressbook = collections.find((c) => c.href === addressbookUrl);
    expect(calendar).toMatchObject({
      kind: "calendar",
      sync_tier: "sync",
      initial_sync_done: true,
      backfill_total: 3,
      total_count: 3,
    });
    expect(calendar?.sync_token).toBeTruthy();
    expect(addressbook).toMatchObject({
      kind: "addressbook",
      initial_sync_done: true,
      backfill_total: 1,
      total_count: 1,
    });
  });

  test("the backfill parsed a vCard's FN and emails", async () => {
    const contact = await ctx.db
      .selectFrom("dav_objects")
      .select(["component", "summary", "emails", "uid"])
      .where("account_id", "=", ctx.davAccountId)
      .where("kind", "=", "addressbook")
      .executeTakeFirstOrThrow();
    expect(contact.component).toBe("VCARD");
    expect(contact.summary).toBe("Ada Lovelace");
    expect(contact.emails).toEqual(["ada@example.com"]);
  });

  test("backfill fired one sync_complete per collection and no per-object insert events", async () => {
    await waitFor(
      () => eventsOf("dav_collection").filter((e) => e.op === "sync_complete").length >= 2,
    );
    const complete = eventsOf("dav_collection").filter((e) => e.op === "sync_complete");
    expect(complete.every((e) => e.backfill === true && e.origin === "sync")).toBe(true);
    expect(eventsOf("dav_object").filter((e) => e.op === "insert")).toHaveLength(0);

    const started = eventsOf("dav_collection").filter(
      (e) => e.op === "update" && e.changed?.includes("backfill_total"),
    );
    expect(started.length).toBeGreaterThanOrEqual(2);
  });

  test("a requested sync picks up an object created on the server, with an origin=sync insert event", async () => {
    events = [];
    const uid = `live-${randomUUID()}`;
    await client.put(
      new URL(`${uid}.ics`, calendarUrl).toString(),
      sampleEvent(uid, "Arrived Later"),
      "text/calendar; charset=utf-8",
      { create: true },
    );

    await accountSync.requestSync();

    const row = await ctx.db
      .selectFrom("dav_objects")
      .select(["summary"])
      .where("account_id", "=", ctx.davAccountId)
      .where("uid", "=", uid)
      .executeTakeFirstOrThrow();
    expect(row.summary).toBe("Arrived Later");

    await waitFor(() => eventsOf("dav_object").some((e) => e.op === "insert"));
    const insert = eventsOf("dav_object").find((e) => e.op === "insert");
    expect(insert?.origin).toBe("sync");
  });

  test("a consumer write while the account is active reaches the server through the subscribed outbound", async () => {
    const collection = await ctx.db
      .selectFrom("dav_collections")
      .select("id")
      .where("account_id", "=", ctx.davAccountId)
      .where("href", "=", calendarUrl)
      .executeTakeFirstOrThrow();
    const uid = `consumer-${randomUUID()}`;
    const [obj] = await ctx.pgSql<{ id: string }[]>`
      INSERT INTO dav_objects (account_id, collection_id, data)
      VALUES (${ctx.davAccountId}, ${collection.id}, ${sampleEvent(uid, "From the consumer")})
      RETURNING id
    `;

    const row = await waitFor(async () => {
      const r = await ctx.db
        .selectFrom("dav_objects")
        .select(["href", "etag"])
        .where("id", "=", obj.id)
        .executeTakeFirstOrThrow();
      return r.href && r.etag ? r : null;
    });
    expect(await client.getEtag(row.href as string)).toBe(row.etag);
  });

  test("stop() leaves the account disabled", async () => {
    await accountSync.stop();
    expect(accountSync.getState()).toBe("disabled");
    const account = await ctx.db
      .selectFrom("dav_accounts")
      .select("state")
      .where("id", "=", ctx.davAccountId)
      .executeTakeFirstOrThrow();
    expect(account.state).toBe("disabled");
  });
});
