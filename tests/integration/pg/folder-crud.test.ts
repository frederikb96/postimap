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
let accountId: string;

interface QueueRow {
  action: string;
  folder_id: string | null;
  payload: { imap_name?: string };
}

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
  accountId = randomUUID();
  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'folder-crud', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;
});

function queued(): Promise<QueueRow[]> {
  return pgSql<QueueRow[]>`
    SELECT action, folder_id::text AS folder_id, payload FROM sync_queue
    WHERE account_id = ${accountId} ORDER BY created_at
  `;
}

async function insertFolder(name: string): Promise<string> {
  const id = randomUUID();
  await pgSql`
    INSERT INTO folders (id, account_id, imap_name) VALUES (${id}, ${accountId}, ${name})
  `;
  return id;
}

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

describe("folder create/delete enqueue", () => {
  test("an app INSERT enqueues folder_create carrying the name", async () => {
    const folderId = await insertFolder("Archive/2026");

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("folder_create");
    expect(rows[0].folder_id).toBe(folderId);
    expect(rows[0].payload.imap_name).toBe("Archive/2026");
  });

  test("the folder reconciliation's own INSERT enqueues nothing", async () => {
    // syncFoldersToPg inserts every folder it discovers inside withSyncWriter. Without
    // the guard, mirroring a folder from the server would ask the server to create it.
    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL postimap.writer = 'sync'`;
      await tx`
        INSERT INTO folders (account_id, imap_name) VALUES (${accountId}, 'Discovered')
      `;
    });

    expect(await queued()).toHaveLength(0);
  });

  test("an app tombstone enqueues folder_delete", async () => {
    const folderId = await insertFolder("Junk");
    await pgSql`DELETE FROM sync_queue WHERE account_id = ${accountId}`;

    await pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("folder_delete");
    expect(rows[0].payload.imap_name).toBe("Junk");
  });

  test("the reconciliation's own tombstone enqueues nothing", async () => {
    // A folder that disappears from LIST is soft-deleted by the sync engine. Asking the
    // server to delete a mailbox it has already lost would be both wrong and dangerous.
    const folderId = await insertFolder("Gone");
    await pgSql`DELETE FROM sync_queue WHERE account_id = ${accountId}`;

    await pgSql.begin(async (tx) => {
      await tx`SET LOCAL postimap.writer = 'sync'`;
      await tx`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;
    });

    expect(await queued()).toHaveLength(0);
  });

  test("clearing deleted_at does not enqueue a delete", async () => {
    const folderId = await insertFolder("Back");
    await pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;
    await pgSql`DELETE FROM sync_queue WHERE account_id = ${accountId}`;

    await pgSql`UPDATE folders SET deleted_at = NULL WHERE id = ${folderId}`;

    expect(await queued()).toHaveLength(0);
  });

  test("an unrelated column change enqueues nothing", async () => {
    const folderId = await insertFolder("Quiet");
    await pgSql`DELETE FROM sync_queue WHERE account_id = ${accountId}`;

    await pgSql`UPDATE folders SET display_name = 'Renamed for display' WHERE id = ${folderId}`;

    expect(await queued()).toHaveLength(0);
  });
});

describe("folder write contract", () => {
  test("postimap_app can create a folder and tombstone one", async () => {
    const folderId = await insertFolder("Existing");

    await asAppRole(async (tx) => {
      await expect(
        tx`INSERT INTO folders (account_id, imap_name) VALUES (${accountId}, 'AppMade')`,
      ).resolves.toBeDefined();
      await expect(
        tx`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`,
      ).resolves.toBeDefined();
    });
  });

  test("postimap_app cannot rename a folder", async () => {
    // IMAP RENAME also renames every child, so one command invalidates the imap_name of
    // an unbounded number of other rows. A rename reaches PG only from the server.
    const folderId = await insertFolder("Fixed");

    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE folders SET imap_name = 'Renamed' WHERE id = ${folderId}`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  test("postimap_app cannot write IMAP bookkeeping columns", async () => {
    const folderId = await insertFolder("Bookkeeping");

    // One transaction per probe: the first refusal aborts the transaction, so a second
    // statement inside it reports that rather than its own permission failure.
    await asAppRole(async (tx) => {
      await expect(tx`UPDATE folders SET uidvalidity = 99 WHERE id = ${folderId}`).rejects.toThrow(
        /permission denied/i,
      );
    });
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE folders SET initial_sync_done = true WHERE id = ${folderId}`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  test("postimap_app cannot DELETE a folder row -- tombstoning is the only removal", async () => {
    const folderId = await insertFolder("Undeletable");

    await asAppRole(async (tx) => {
      await expect(tx`DELETE FROM folders WHERE id = ${folderId}`).rejects.toThrow(
        /permission denied/i,
      );
    });
  });
});
