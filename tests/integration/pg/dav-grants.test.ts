import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectPg,
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "../../setup/pg-helpers.js";

let pgSql: postgres.Sql;
let schema: string;
let davAccountId: string;
let davCollectionId: string;
let davObjectId: string;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);
  await pgSql`GRANT postimap_app TO CURRENT_USER`;
});

afterAll(async () => {
  if (pgSql && schema) {
    await dropTestSchema(pgSql, schema);
    await pgSql.end();
  }
});

beforeEach(async () => {
  await truncateAll(pgSql);

  davAccountId = randomUUID();
  davCollectionId = randomUUID();
  davObjectId = randomUUID();

  await pgSql`
    INSERT INTO dav_accounts (id, name, url, username, password, is_active, state)
    VALUES (${davAccountId}, 'dav-grants-test', 'https://dav.example.org/', 'u',
      ${Buffer.from([0x00])}, true, 'active')
  `;
  await pgSql`
    INSERT INTO dav_collections (id, account_id, kind, href, slug, display_name)
    VALUES (${davCollectionId}, ${davAccountId}, 'calendar', 'https://dav.example.org/u/cal/', 'cal', 'Cal')
  `;
  await pgSql`
    INSERT INTO dav_objects (id, account_id, collection_id, href, etag, kind, data, uid)
    VALUES (${davObjectId}, ${davAccountId}, ${davCollectionId},
      'https://dav.example.org/u/cal/evt-1.ics', '"etag1"', 'calendar',
      'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'evt-1')
  `;
});

/** Runs `fn` as postimap_app; always rolls back so attempts never persist. */
async function asAppRole<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let captured: T;
  await pgSql
    .begin(async (tx) => {
      await tx`SET LOCAL ROLE postimap_app`;
      captured = await fn(tx);
      throw new Error("rollback-after-probe");
    })
    .catch((err) => {
      if (!(err instanceof Error) || err.message !== "rollback-after-probe") throw err;
    });
  // biome-ignore lint/style/noNonNullAssertion: always assigned before the sentinel throw
  return captured!;
}

describe("postimap_app grants: DAV allowed writes", () => {
  test("can SELECT every DAV table except dav_sync_queue", async () => {
    await asAppRole(async (tx) => {
      await expect(tx`SELECT * FROM dav_accounts`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM dav_collections`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM dav_objects`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM dav_notifications`).resolves.toBeDefined();
    });
  });

  test("can INSERT a new DAV account with the documented insert surface", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          INSERT INTO dav_accounts (id, name, url, username, password, is_active)
          VALUES (gen_random_uuid(), 'app-created', 'https://x/', 'u', ${Buffer.from([0x00])}, true)
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can UPDATE the granted dav_accounts columns", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE dav_accounts SET name = 'renamed', is_active = false WHERE id = ${davAccountId}`,
      ).resolves.toBeDefined();
    });
  });

  test("can DELETE a DAV account, and the cascade takes its collections/objects with it", async () => {
    await asAppRole(async (tx) => {
      await expect(tx`DELETE FROM dav_accounts WHERE id = ${davAccountId}`).resolves.toBeDefined();
      const [collections] =
        await tx`SELECT count(*)::int AS n FROM dav_collections WHERE id = ${davCollectionId}`;
      const [objects] =
        await tx`SELECT count(*)::int AS n FROM dav_objects WHERE id = ${davObjectId}`;
      expect(collections.n).toBe(0);
      expect(objects.n).toBe(0);
    });
  });

  test("can INSERT a new collection with the documented insert surface", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          INSERT INTO dav_collections (id, account_id, kind, slug, display_name, color, description)
          VALUES (gen_random_uuid(), ${davAccountId}, 'calendar', 'work', 'Work', '#ff0000', 'desc')
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can UPDATE the granted dav_collections columns", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE dav_collections SET display_name = 'renamed', color = '#000', description = 'd', deleted_at = now() WHERE id = ${davCollectionId}`,
      ).resolves.toBeDefined();
    });
  });

  test("can INSERT a new object with only account_id/collection_id/data", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          INSERT INTO dav_objects (id, account_id, collection_id, data)
          VALUES (gen_random_uuid(), ${davAccountId}, ${davCollectionId}, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can UPDATE the granted dav_objects columns (data, collection_id, deleted_at)", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          UPDATE dav_objects SET data = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
            collection_id = ${davCollectionId}, deleted_at = now()
          WHERE id = ${davObjectId}
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can acknowledge a DAV notification", async () => {
    const [row] = await pgSql`
      INSERT INTO dav_notifications (account_id, action, collection_id, object_id, error)
      VALUES (${davAccountId}, 'put', ${davCollectionId}, ${davObjectId}, 'boom')
      RETURNING id
    `;
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE dav_notifications SET acknowledged_at = now() WHERE id = ${row.id}`,
      ).resolves.toBeDefined();
    });
  });
});

describe("postimap_app grants: DAV forbidden writes", () => {
  test("cannot INSERT the PostIMAP-managed href/etag/state columns of a dav_account", async () => {
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO dav_accounts (name, url, username, password, state)
          VALUES ('sneaky', 'https://x/', 'u', ${Buffer.from([0x00])}, 'active')
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot UPDATE a dav_account column outside the grant list (e.g. state, principal_url)", async () => {
    await expect(
      asAppRole((tx) => tx`UPDATE dav_accounts SET state = 'active' WHERE id = ${davAccountId}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole(
        (tx) =>
          tx`UPDATE dav_accounts SET principal_url = 'https://hacked/' WHERE id = ${davAccountId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot INSERT the PostIMAP-managed href of a dav_collection", async () => {
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO dav_collections (account_id, kind, slug, href)
          VALUES (${davAccountId}, 'calendar', 'sneaky', 'https://x/sneaky/')
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot UPDATE a dav_collection column outside the create/props surface", async () => {
    await expect(
      asAppRole(
        (tx) =>
          tx`UPDATE dav_collections SET href = 'https://hacked/' WHERE id = ${davCollectionId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole(
        (tx) => tx`UPDATE dav_collections SET sync_token = 'hacked' WHERE id = ${davCollectionId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot INSERT the parsed columns of a dav_object -- they are PostIMAP's reading of data", async () => {
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO dav_objects (account_id, collection_id, data, uid)
          VALUES (${davAccountId}, ${davCollectionId}, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'sneaky-uid')
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO dav_objects (account_id, collection_id, data, etag)
          VALUES (${davAccountId}, ${davCollectionId}, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', '"sneaky"')
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot UPDATE a dav_object's parsed columns directly (e.g. summary, dtstart)", async () => {
    await expect(
      asAppRole((tx) => tx`UPDATE dav_objects SET summary = 'hacked' WHERE id = ${davObjectId}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole((tx) => tx`UPDATE dav_objects SET etag = '"hacked"' WHERE id = ${davObjectId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot touch dav_sync_queue at all", async () => {
    await expect(asAppRole((tx) => tx`SELECT * FROM dav_sync_queue`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  test("cannot DELETE a collection or object -- only cascade from the account does that", async () => {
    await expect(
      asAppRole((tx) => tx`DELETE FROM dav_collections WHERE id = ${davCollectionId}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole((tx) => tx`DELETE FROM dav_objects WHERE id = ${davObjectId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot write anything on dav_notifications except acknowledged_at", async () => {
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO dav_notifications (account_id, action, error)
          VALUES (${davAccountId}, 'put', 'sneaky')
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
