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

  test("can DELETE an account, and the cascade takes its folders and messages with it", async () => {
    await asAppRole(async (tx) => {
      await expect(tx`DELETE FROM accounts WHERE id = ${accountId}`).resolves.toBeDefined();

      // No delete grant on folders or messages -- the FK cascades do this, which is why
      // the grant is on accounts alone.
      const [folders] = await tx`SELECT count(*)::int AS n FROM folders WHERE id = ${folderId}`;
      const [messages] = await tx`SELECT count(*)::int AS n FROM messages WHERE id = ${messageId}`;
      expect(folders.n).toBe(0);
      expect(messages.n).toBe(0);
    });
  });

  test("can INSERT into outbox and outbox_attachments", async () => {
    await asAppRole(async (tx) => {
      const outboxId = randomUUID();
      // id and max_attempts stay insertable: a consumer picking its own primary key can
      // attach a file before the row is claimed, and a row may need a tighter retry cap.
      await expect(
        tx`
          INSERT INTO outbox (id, account_id, kind, max_attempts)
          VALUES (${outboxId}, ${accountId}, 'draft', 2)
        `,
      ).resolves.toBeDefined();
      await expect(
        tx`INSERT INTO outbox_attachments (outbox_id, filename) VALUES (${outboxId}, 'a.txt')`,
      ).resolves.toBeDefined();
    });
  });

  test("can INSERT an outbox row naming replaces_message_id", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          INSERT INTO outbox (account_id, kind, replaces_message_id)
          VALUES (${accountId}, 'draft', ${messageId})
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can INSERT a new folder (create)", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`
          INSERT INTO folders (account_id, imap_name, display_name)
          VALUES (${accountId}, 'Custom', 'My folder')
        `,
      ).resolves.toBeDefined();
    });
  });

  test("can UPDATE folders.display_name and folders.deleted_at", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE folders SET display_name = 'Renamed label' WHERE id = ${folderId}`,
      ).resolves.toBeDefined();
      await expect(
        tx`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`,
      ).resolves.toBeDefined();
    });
  });

  test("can SELECT and acknowledge a sync_notifications row", async () => {
    const notificationId = (
      await pgSql`
        INSERT INTO sync_notifications (account_id, action, folder_id, error)
        VALUES (${accountId}, 'send', ${folderId}, 'SMTP refused')
        RETURNING id
      `
    )[0].id;

    await asAppRole(async (tx) => {
      const rows = await tx`SELECT * FROM sync_notifications WHERE id = ${notificationId}`;
      expect(rows).toHaveLength(1);

      await expect(
        tx`UPDATE sync_notifications SET acknowledged_at = now() WHERE id = ${notificationId}`,
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

  test("cannot INSERT the PostIMAP-managed columns of an outbox row", async () => {
    // The reason this is enforced in the database rather than described in a doc: an ORM
    // sending a model default on every INSERT writes `status` without the calling code
    // ever mentioning it, and the row is then never claimed -- the mail silently never
    // leaves and nothing reports an error.
    await expect(
      asAppRole(
        (tx) =>
          tx`INSERT INTO outbox (account_id, kind, status) VALUES (${accountId}, 'draft', 'sent')`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole(
        (tx) =>
          tx`INSERT INTO outbox (account_id, kind, attempts) VALUES (${accountId}, 'draft', 3)`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole(
        (tx) =>
          tx`INSERT INTO outbox (account_id, kind, sent_at) VALUES (${accountId}, 'draft', now())`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot INSERT the PostIMAP-managed columns of an account", async () => {
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO accounts (name, imap_host, imap_port, imap_user, imap_password, state)
          VALUES ('sneaky', 'h', 993, 'u', ${Buffer.from([0x00])}, 'active')
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole(
        (tx) => tx`
          INSERT INTO accounts (name, imap_host, imap_port, imap_user, imap_password, capabilities)
          VALUES ('sneaky', 'h', 993, 'u', ${Buffer.from([0x00])}, '{}'::jsonb)
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot touch sync_queue at all", async () => {
    await expect(asAppRole((tx) => tx`SELECT * FROM sync_queue`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  test("cannot DELETE anything but an account -- children go only via the cascade", async () => {
    await expect(
      asAppRole((tx) => tx`DELETE FROM messages WHERE id = ${messageId}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(asAppRole((tx) => tx`DELETE FROM folders WHERE id = ${folderId}`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asAppRole((tx) => tx`DELETE FROM outbox`)).rejects.toThrow(/permission denied/i);
  });

  test("cannot UPDATE a folder column outside the create/delete surface", async () => {
    // deleted_at and display_name are writable (folder deletion, and a label for the
    // consumer's own UI). Everything else on the row is IMAP state or bookkeeping --
    // imap_name most of all, since a rename cascades to every child folder.
    await expect(
      asAppRole((tx) => tx`UPDATE folders SET imap_name = 'hacked' WHERE id = ${folderId}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAppRole((tx) => tx`UPDATE folders SET uidnext = 42 WHERE id = ${folderId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("can request IMAP push for a folder, and cannot write the status of that request", async () => {
    await asAppRole(async (tx) => {
      await expect(
        tx`UPDATE folders SET idle_requested = true WHERE id = ${folderId}`,
      ).resolves.toBeDefined();
    });

    // idle_status is PostIMAP's answer -- a consumer writing it could claim a folder is
    // being watched when no connection is open.
    await expect(
      asAppRole((tx) => tx`UPDATE folders SET idle_status = 'watching' WHERE id = ${folderId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  test("cannot INSERT into sync_notifications, and cannot UPDATE a column other than acknowledged_at", async () => {
    await expect(
      asAppRole(
        (tx) =>
          tx`INSERT INTO sync_notifications (account_id, action) VALUES (${accountId}, 'send')`,
      ),
    ).rejects.toThrow(/permission denied/i);

    const notificationId = (
      await pgSql`
        INSERT INTO sync_notifications (account_id, action, folder_id, error)
        VALUES (${accountId}, 'send', ${folderId}, 'SMTP refused')
        RETURNING id
      `
    )[0].id;

    // The row still renders the server's message after the fact -- a consumer marking a
    // notification "not actually an error" would defeat the point of it.
    await expect(
      asAppRole(
        (tx) => tx`UPDATE sync_notifications SET error = 'edited' WHERE id = ${notificationId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
