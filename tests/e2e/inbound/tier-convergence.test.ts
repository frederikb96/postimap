import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { ServerCapabilities, SyncTier } from "../../../src/imap/capabilities.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  connectImap,
  deliverAndWait,
  setupE2EContext,
  teardownE2EContext,
} from "../../setup/e2e-helpers.js";

/**
 * Forces `selectSyncTier` to pick each tier while running against the same real server
 * (Dovecot, CONDSTORE+QRESYNC both on) -- the ImapFlow connection itself always has both
 * extensions enabled (see pool.ts), so what changes between these three runs is purely
 * which detection algorithm change-detector.ts uses, exactly the variable the three-tier
 * architecture claims is interchangeable.
 */
const TIER_CAPABILITIES: Record<SyncTier, ServerCapabilities> = {
  full: {
    condstore: false,
    qresync: false,
    idle: true,
    move: true,
    uidplus: true,
    mailboxId: false,
  },
  condstore: {
    condstore: true,
    qresync: false,
    idle: true,
    move: true,
    uidplus: true,
    mailboxId: false,
  },
  qresync: {
    condstore: true,
    qresync: true,
    idle: true,
    move: true,
    uidplus: true,
    mailboxId: false,
  },
};

describe.each(["full", "condstore", "qresync"] satisfies SyncTier[])(
  "E2E: inbound convergence -- tier=%s",
  (tier) => {
    test("new mail, a flag change, and a deletion all converge to the same final PG state", async () => {
      const ctx = await setupE2EContext({ emailPrefix: `e2e-tier-${tier}` });
      try {
        const sync = new InboundSync(
          ctx.imapClient,
          ctx.db,
          ctx.accountId,
          TIER_CAPABILITIES[tier],
        );

        // Initial full sync -- empty mailbox.
        const initial = await sync.fullSync(ctx.folderId, "INBOX", true);
        expect(initial.errors).toEqual([]);

        const subject = `Tier Convergence ${tier} ${randomUUID().slice(0, 8)}`;
        const rawClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
        try {
          await deliverAndWait({
            from: ctx.testEmail,
            to: ctx.testEmail,
            subject,
            text: "Convergence body.",
            imapClient: rawClient,
          });
        } finally {
          await rawClient.logout();
        }

        // Fresh connection so the tier under test sees this as a genuine incoming
        // change to detect, not state it already observed while delivering.
        await ctx.imapClient.disconnect();
        await ctx.imapClient.connect();

        const afterNew = await sync.syncFolder(ctx.folderId, "INBOX");
        expect(afterNew.errors).toEqual([]);
        expect(afterNew.newMessages).toBeGreaterThanOrEqual(1);

        const rowsAfterNew = await ctx.pgSql`
            SELECT imap_uid FROM messages
            WHERE folder_id = ${ctx.folderId} AND subject = ${subject} AND expunged_at IS NULL
          `;
        expect(rowsAfterNew).toHaveLength(1);
        const targetUid = Number(rowsAfterNew[0].imap_uid);

        // Flag \Seen via a separate connection.
        const flagClient = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
        try {
          const lock = await flagClient.getMailboxLock("INBOX");
          try {
            await flagClient.messageFlagsAdd({ uid: targetUid }, ["\\Seen"], { uid: true });
          } finally {
            lock.release();
          }
        } finally {
          await flagClient.logout();
        }

        // Fresh connection before every check, same reasoning as above: the shared
        // connection's per-session view of the mailbox can otherwise lag an external
        // change from a different connection by the width of one round trip, which is
        // Dovecot server behavior, not something any tier's detection logic controls.
        await ctx.imapClient.disconnect();
        await ctx.imapClient.connect();

        const afterFlag = await sync.syncFolder(ctx.folderId, "INBOX");
        expect(afterFlag.errors).toEqual([]);
        expect(afterFlag.updatedFlags).toBeGreaterThanOrEqual(1);

        // Delete via a separate connection.
        const deleteClient = await connectImap({
          user: ctx.testEmail,
          password: ctx.testPassword,
        });
        try {
          const lock = await deleteClient.getMailboxLock("INBOX");
          try {
            await deleteClient.messageDelete({ uid: targetUid }, { uid: true });
          } finally {
            lock.release();
          }
        } finally {
          await deleteClient.logout();
        }

        await ctx.imapClient.disconnect();
        await ctx.imapClient.connect();

        const afterDelete = await sync.syncFolder(ctx.folderId, "INBOX");
        expect(afterDelete.errors).toEqual([]);
        expect(afterDelete.deletedMessages).toBeGreaterThanOrEqual(1);

        const finalRows = await ctx.pgSql`
            SELECT is_seen, expunged_at FROM messages
            WHERE folder_id = ${ctx.folderId} AND subject = ${subject}
          `;
        expect(finalRows).toHaveLength(1);
        expect(finalRows[0].is_seen).toBe(true);
        expect(finalRows[0].expunged_at).not.toBeNull();
      } finally {
        await teardownE2EContext(ctx);
      }
    }, 30_000);
  },
);
