import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { decryptPassword, encryptPassword } from "../../../src/crypto.js";
import { encryptStoredCredentials } from "../../../src/db/credentials.js";
import type { Database } from "../../../src/db/schema.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
  truncateAll,
} from "../../setup/pg-helpers.js";
import { waitFor } from "../../setup/wait-for.js";

const KEY = "a".repeat(64);
const IMAP_PASSWORD = "imap-secret";
const SMTP_PASSWORD = "smtp-secret";

let pgSql: postgres.Sql;
let schema: string;
let db: Kysely<Database>;
let accountId: string;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  db = createTestDb(getDatabaseUrl(schema));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

async function insertAccount(imap: Buffer, smtp: Buffer | null): Promise<void> {
  accountId = randomUUID();
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
                          smtp_host, smtp_port, smtp_user, smtp_password, is_active, state)
    VALUES (${accountId}, ${`creds-${randomUUID()}`}, '127.0.0.1', 993, 'test@test.local',
      ${imap}, '127.0.0.1', 587, 'test@test.local', ${smtp}, true, 'active')
  `;
}

async function readCredentials(): Promise<{ imap: Buffer; smtp: Buffer | null }> {
  const [row] = await pgSql<{ imap_password: Buffer; smtp_password: Buffer | null }[]>`
    SELECT imap_password, smtp_password FROM accounts WHERE id = ${accountId}
  `;
  return { imap: row.imap_password, smtp: row.smtp_password };
}

beforeEach(async () => {
  await truncateAll(pgSql);
});

describe("credential encryption at rest", () => {
  test("re-encrypts plaintext credentials once a key is configured", async () => {
    await insertAccount(encryptPassword(IMAP_PASSWORD), encryptPassword(SMTP_PASSWORD));

    const columns = await encryptStoredCredentials(db, accountId, KEY);
    expect(columns.sort()).toEqual(["imap_password", "smtp_password"]);

    const { imap, smtp } = await readCredentials();
    expect(imap[0]).toBe(0x01);
    expect(smtp?.[0]).toBe(0x01);
    expect(decryptPassword(imap, KEY)).toBe(IMAP_PASSWORD);
    expect(smtp && decryptPassword(smtp, KEY)).toBe(SMTP_PASSWORD);
  });

  test("is idempotent -- a second pass rewrites nothing", async () => {
    await insertAccount(encryptPassword(IMAP_PASSWORD), null);
    await encryptStoredCredentials(db, accountId, KEY);
    const first = await readCredentials();

    expect(await encryptStoredCredentials(db, accountId, KEY)).toEqual([]);

    // Byte-identical, not merely decryptable: a needless rewrite would draw a fresh IV.
    expect((await readCredentials()).imap.equals(first.imap)).toBe(true);
  });

  test("leaves credentials alone when no key is configured", async () => {
    const stored = encryptPassword(IMAP_PASSWORD);
    await insertAccount(stored, null);

    expect(await encryptStoredCredentials(db, accountId, undefined)).toEqual([]);
    expect((await readCredentials()).imap.equals(stored)).toBe(true);
  });

  test("re-encrypts imap_password when smtp_password is NULL", async () => {
    await insertAccount(encryptPassword(IMAP_PASSWORD), null);

    expect(await encryptStoredCredentials(db, accountId, KEY)).toEqual(["imap_password"]);

    const { imap, smtp } = await readCredentials();
    expect(decryptPassword(imap, KEY)).toBe(IMAP_PASSWORD);
    expect(smtp).toBeNull();
  });

  test("re-encrypts a credential a consumer rewrote as plaintext", async () => {
    await insertAccount(encryptPassword(IMAP_PASSWORD, KEY), null);
    await pgSql`
      UPDATE accounts SET imap_password = ${encryptPassword("rotated")} WHERE id = ${accountId}
    `;

    expect(await encryptStoredCredentials(db, accountId, KEY)).toEqual(["imap_password"]);
    expect(decryptPassword((await readCredentials()).imap, KEY)).toBe("rotated");
  });

  test("does not wake consumers -- a password rewrite fires no postimap_events", async () => {
    await insertAccount(encryptPassword(IMAP_PASSWORD), null);

    const listenerSql = connectPg(schema);
    const events: unknown[] = [];
    const subscription = await listenerSql.listen("postimap_events", (payload) => {
      events.push(JSON.parse(payload));
    });

    try {
      await encryptStoredCredentials(db, accountId, KEY);

      // A watched-column update fires an event and acts as the ordering barrier: once it
      // arrives, anything the password rewrite emitted would already have been delivered.
      await pgSql`UPDATE accounts SET name = ${`barrier-${randomUUID()}`} WHERE id = ${accountId}`;
      await waitFor(() => events.length > 0);

      expect(events).toHaveLength(1);
      expect((events[0] as { changed: string[] }).changed).toEqual(["name"]);
    } finally {
      await subscription.unlisten();
      await listenerSql.end();
    }
  });

  test("returns nothing for an account that does not exist", async () => {
    expect(await encryptStoredCredentials(db, randomUUID(), KEY)).toEqual([]);
  });
});
