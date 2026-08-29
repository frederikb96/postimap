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
let folderId: string;
let messageId: string;

beforeAll(async () => {
  const bootstrapSql = connectPg();
  schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  pgSql = connectPg(schema);

  // Test connection is a superuser (POSTGRES_USER bootstrap role), so it can grant the
  // NOLOGIN postimap_app role to itself regardless of ADMIN OPTION -- this is how a real
  // deployment grants postimap_app to a consumer's login role, just applied to the same
  // connection so tests can SET ROLE into it.
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
  folderId = randomUUID();
  messageId = randomUUID();

  await pgSql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password, is_active, state)
    VALUES (${accountId}, 'grants-test', '127.0.0.1', 11143, 'test@test.local',
      ${Buffer.from("pass")}, true, 'active')
  `;

  await pgSql`
    INSERT INTO folders (id, account_id, imap_name, display_name, special_use)
    VALUES (${folderId}, ${accountId}, 'INBOX', 'Inbox', 'inbox')
  `;

  await pgSql`
    INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
    VALUES (${messageId}, ${accountId}, ${folderId}, '1', 'Grants Test')
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

describe("postimap_app grants: allowed writes", () => {
  test("can SELECT accounts, folders, messages, attachments", async () => {
    await asAppRole(async (tx) => {
      await expect(tx`SELECT * FROM accounts`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM folders`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM messages`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM attachments`).resolves.toBeDefined();
      await expect(tx`SELECT * FROM postimap_info`).resolves.toBeDefined();
    });
  });

  test("can INSERT a new account", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          INSERT INTO accounts (name, imap_host, imap_port, imap_user, imap_password)
          VALUES ('app-created', 'h', 993, 'u', ${Buffer.from([0x00])})
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can UPDATE the granted account columns", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE accounts SET is_active = false, name = 'renamed' WHERE id = ${accountId}`,
      ).resolves.toBeDefined();
    });
  });

  test("can UPDATE the granted message columns", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          UPDATE messages SET is_seen = true, is_flagged = true, folder_id = ${folderId},
            expunged_at = now()
          WHERE id = ${messageId}
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can INSERT into outbox and outbox_attachments", async () => {
    await asAppRole(async (tx) => {
      const outboxId = randomUUID();
      await expect(
        tx`INSERT INTO outbox (id, account_id, kind) VALUES (${outboxId}, ${accountId}, 'draft')`,
      ).resolves.toBeDefined();
      await expect(
        tx`INSERT INTO outbox_attachments (outbox_id, filename) VALUES (${outboxId}, 'a.txt')`,
      ).resolves.toBeDefined();
    });
  });
});

describe("postimap_app grants: forbidden writes", () => {
  test("cannot UPDATE a message column outside the grant list (e.g. subject)", async () => {
    await expect(
      asAppRole((tx) => tx`UPDATE messages SET subject = 'hacked' WHERE id = ${messageId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot INSERT a message directly (only PostIMAP's sync engine does)", async () => {
    await expect(
      asAppRole(
        (tx) =>
          tx`INSERT INTO messages (account_id, folder_id, imap_uid) VALUES (${accountId}, ${folderId}, '2')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot UPDATE an account column outside the grant list (e.g. capabilities, state)", async () => {
    await expect(
      asAppRole((tx) => tx`UPDATE accounts SET state = 'active' WHERE id = ${accountId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot touch sync_queue at all", async () => {
    await expect(asAppRole((tx) => tx`SELECT * FROM sync_queue`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  test("cannot DELETE from any granted table", async () => {
    await expect(
      asAppRole((tx) => tx`DELETE FROM messages WHERE id = ${messageId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot UPDATE folders at all (no UPDATE grant on folders)", async () => {
    await expect(
      asAppRole((tx) => tx`UPDATE folders SET display_name = 'hacked' WHERE id = ${folderId}`),
    ).rejects.toThrow(/permission denied/i);
  });
});
