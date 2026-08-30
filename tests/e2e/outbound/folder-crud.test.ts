import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { discoverFolders, syncFoldersToPg } from "../../../src/protocol/folder-sync.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  connectImap,
  type E2EContext,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await setupE2EContext({ emailPrefix: "e2e-foldercrud" });
});

afterAll(async () => {
  await teardownE2EContext(ctx);
});

function makeProcessor(): OutboundProcessor {
  return new OutboundProcessor(
    ctx.db,
    getDatabaseUrl(ctx.schema),
    () => ctx.imapClient,
    async () => testCapabilities,
    60_000,
    5,
  );
}

/** LIST from a connection of its own, so nothing is answered from a cached mailbox. */
async function serverHasFolder(name: string): Promise<boolean> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    const listed = await client.list();
    return listed.some((entry) => entry.path === name);
  } finally {
    await client.logout();
  }
}

async function insertFolderAsApp(name: string): Promise<string> {
  const id = randomUUID();
  await ctx.pgSql`
    INSERT INTO folders (id, account_id, imap_name) VALUES (${id}, ${ctx.accountId}, ${name})
  `;
  return id;
}

describe("E2E: folder create and delete (PG -> IMAP)", () => {
  test("an app INSERT into folders creates the mailbox on the server", async () => {
    const name = `AppMade-${randomUUID().slice(0, 8)}`;
    await insertFolderAsApp(name);

    expect(await serverHasFolder(name)).toBe(false);
    await makeProcessor().drain(ctx.accountId);

    expect(await serverHasFolder(name)).toBe(true);
  });

  test("tombstoning the row deletes the mailbox", async () => {
    const name = `ToDelete-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolderAsApp(name);
    await makeProcessor().drain(ctx.accountId);
    expect(await serverHasFolder(name)).toBe(true);

    await ctx.pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;
    await makeProcessor().drain(ctx.accountId);

    expect(await serverHasFolder(name)).toBe(false);
  });

  test("reconciliation leaves a folder alone while its create is still queued", async () => {
    // The window this guards: PG holds a live folder the server has never heard of, which
    // is indistinguishable from a folder that was deleted on the server unless the queue
    // is consulted. Tombstoning it here would undo the consumer's request.
    const name = `Pending-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolderAsApp(name);

    const remote = await discoverFolders(ctx.imapClient.client);
    await syncFoldersToPg(ctx.db, ctx.accountId, remote, testCapabilities);

    const [row] = await ctx.pgSql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM folders WHERE id = ${folderId}
    `;
    expect(row.deleted_at).toBeNull();

    await makeProcessor().drain(ctx.accountId);
    expect(await serverHasFolder(name)).toBe(true);
  });

  test("reconciliation leaves a tombstone alone while its delete is still queued", async () => {
    // The mirror image: the folder is still on the server because the DELETE has not run,
    // and clearing deleted_at here would cancel the request instead of completing it.
    const name = `PendingDel-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolderAsApp(name);
    await makeProcessor().drain(ctx.accountId);

    await ctx.pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;

    const remote = await discoverFolders(ctx.imapClient.client);
    await syncFoldersToPg(ctx.db, ctx.accountId, remote, testCapabilities);

    const [row] = await ctx.pgSql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM folders WHERE id = ${folderId}
    `;
    expect(row.deleted_at).not.toBeNull();

    await makeProcessor().drain(ctx.accountId);
    expect(await serverHasFolder(name)).toBe(false);
  });

  test("a confirmed delete expunges the folder's messages", async () => {
    // The gap this closes: IMAP DELETE destroys the mail outright, so a row left at
    // expunged_at IS NULL describes a message that exists nowhere -- and that predicate is
    // the one every consumer is taught to trust for "live mail".
    const name = `WithMail-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolderAsApp(name);
    await makeProcessor().drain(ctx.accountId);

    const messageId = randomUUID();
    await ctx.pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
      VALUES (${messageId}, ${ctx.accountId}, ${folderId}, '1', 'Doomed')
    `;

    await ctx.pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${folderId}`;
    await makeProcessor().drain(ctx.accountId);

    expect(await serverHasFolder(name)).toBe(false);
    const [msg] = await ctx.pgSql<{ expunged_at: Date | null }[]>`
      SELECT expunged_at FROM messages WHERE id = ${messageId}
    `;
    expect(msg.expunged_at).not.toBeNull();
  });

  test("a delete the server refused leaves the messages alone", async () => {
    // markDead, not markCompleted -- the mail is still on the server, and expunging it in
    // PG would report mail as gone that a user can still see in another client.
    const [inbox] = await ctx.pgSql<{ id: string }[]>`
      SELECT id FROM folders WHERE account_id = ${ctx.accountId} AND imap_name = 'INBOX'
    `;
    const messageId = randomUUID();
    await ctx.pgSql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, subject)
      VALUES (${messageId}, ${ctx.accountId}, ${inbox.id}, '9001', 'Survivor')
    `;

    await ctx.pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${inbox.id}`;
    await makeProcessor().drain(ctx.accountId);

    const [msg] = await ctx.pgSql<{ expunged_at: Date | null }[]>`
      SELECT expunged_at FROM messages WHERE id = ${messageId}
    `;
    expect(msg.expunged_at).toBeNull();

    await ctx.pgSql`UPDATE folders SET deleted_at = NULL WHERE id = ${inbox.id}`;
  });

  test("a name carrying CRLF cannot break the IMAP session", async () => {
    // imap_name is consumer-controlled and reaches the wire. ImapFlow sends a name
    // containing \r\n as a length-prefixed literal rather than quoting it, so it stays
    // data -- what matters here is that the connection is still usable afterwards
    // whatever the server makes of the name.
    await insertFolderAsApp(`Evil-${randomUUID().slice(0, 6)}\r\nA001 LOGOUT`);
    await makeProcessor().drain(ctx.accountId);

    expect(ctx.imapClient.isConnected()).toBe(true);
    await expect(ctx.imapClient.client.list()).resolves.toBeDefined();
  });

  test("a create that dead-letters stops holding the folder live in PG", async () => {
    // getPendingFolderOps counts pending/processing/failed but not dead. Once the request
    // can no longer succeed, the folder's absence from LIST is the truth again and
    // reconciliation tombstones it, rather than leaving a phantom folder live forever.
    const name = `NeverMade-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolderAsApp(name);

    await ctx.pgSql`
      UPDATE sync_queue SET status = 'dead', error = 'refused'
      WHERE account_id = ${ctx.accountId} AND folder_id = ${folderId}
        AND action = 'folder_create'
    `;

    const remote = await discoverFolders(ctx.imapClient.client);
    await syncFoldersToPg(ctx.db, ctx.accountId, remote, testCapabilities);

    const [row] = await ctx.pgSql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM folders WHERE id = ${folderId}
    `;
    expect(row.deleted_at).not.toBeNull();
  });

  test("deleting INBOX dead-letters instead of retrying a refusal forever", async () => {
    const [inbox] = await ctx.pgSql<{ id: string }[]>`
      SELECT id FROM folders WHERE account_id = ${ctx.accountId} AND imap_name = 'INBOX'
    `;
    await ctx.pgSql`UPDATE folders SET deleted_at = now() WHERE id = ${inbox.id}`;

    await makeProcessor().drain(ctx.accountId);

    const [entry] = await ctx.pgSql<{ status: string; error: string }[]>`
      SELECT status, error FROM sync_queue
      WHERE account_id = ${ctx.accountId} AND action = 'folder_delete'
        AND folder_id = ${inbox.id}
    `;
    expect(entry.status).toBe("dead");
    expect(entry.error).toMatch(/INBOX/i);
    expect(await serverHasFolder("INBOX")).toBe(true);
  });
});
