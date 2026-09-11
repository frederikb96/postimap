import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { Subscriber } from "pg-listen";
import { decryptPassword } from "../crypto.js";
import { createPgListener } from "../db/listener.js";
import type { Database } from "../db/schema.js";
import { withSyncWriter } from "../db/writer.js";
import type { ImapClient } from "../imap/pool.js";
import { createLogger } from "../util/logger.js";
import { computeDelay } from "../util/retry.js";

const log = createLogger("outbox");

/** Batch size for outbox processing */
const BATCH_SIZE = 5;

/** One batch in flight for one account, as the stall watchdog sees it. */
interface BatchRun {
  /** When this batch last claimed its rows or finished an entry. */
  progressAt: number;
  abandoned: boolean;
  /** Claimed rows it has not started yet -- the only ones safe to hand to another batch. */
  unstarted: Set<string>;
  /** The claimed row being processed right now. */
  current: string | null;
}

interface OutboxRow {
  id: string;
  account_id: string;
  kind: string;
  from_addr: string | null;
  to_addrs: unknown;
  cc_addrs: unknown;
  bcc_addrs: unknown;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  references: string[] | null;
  status: string;
  attempts: number;
  max_attempts: number;
  sent_message_id: string | null;
  replaces_message_id: string | null;
}

/**
 * The app writes `to_addrs`/`cc_addrs`/`bcc_addrs` as native jsonb arrays -- this only
 * falls back to parsing a string for defensive robustness against a hand-crafted or
 * legacy row, never as the expected shape.
 */
function toAddressArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.length > 0) {
    try {
      return toAddressArray(JSON.parse(value));
    } catch {
      return [value];
    }
  }
  return [];
}

/**
 * Outbox processor: consumes `outbox` rows and turns them into a sent email or an
 * appended draft.
 *
 * The message is composed exactly once via nodemailer's MailComposer, producing both the
 * raw RFC822 bytes and the SMTP envelope (which -- unlike the raw headers -- includes Bcc
 * recipients). For `kind = 'send'` those same raw bytes are what's transmitted over SMTP
 * and what's appended to the Sent folder afterwards: single composition, no risk of the
 * sent copy drifting from what was actually delivered. `kind = 'draft'` skips the SMTP
 * step and appends straight to Drafts.
 *
 * Wakeup via PG LISTEN/NOTIFY per account (`outbox_{account_id}`), with polling
 * fallback, mirroring OutboundProcessor.
 *
 * A wakeup is dropped while the account already has a batch in flight, so a batch that
 * never settles would silence the account for good. One that makes no progress for
 * `stallMs` is given up on instead: its in-flight entry keeps running, since starting it
 * again could deliver the mail twice, the rows it had not started go back to the queue,
 * and a fresh batch takes over. A sweep on the same interval, independent of every
 * per-account wakeup, reports and reschedules any due row nobody has picked up.
 */
export class OutboxProcessor {
  private subscriber: Subscriber | null = null;
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private subscribedChannels = new Set<string>();
  private batches = new Map<string, BatchRun>();
  private sweepRun: { startedAt: number } | null = null;
  /** Accounts already reported as holding rows back, so a long outage logs once. */
  private reportedWaiting = new Set<string>();
  /** Rows already reported as stuck in `processing`. */
  private reportedStuck = new Set<string>();

  constructor(
    private db: Kysely<Database>,
    private databaseUrl: string,
    private getImapClient: (accountId: string) => ImapClient,
    private pollIntervalMs: number,
    private stallMs: number,
    private encryptionKey?: string,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.subscriber = await createPgListener(this.databaseUrl);
    await this.subscriber.connect();

    // Accounts are subscribed by their AccountSync once its IMAP connection is up, not
    // here: nothing can be appended before then, and an attempt made anyway spends one of
    // the row's retries on an error nobody caused.
    this.sweepTimer = setInterval(() => this.scheduleSweep(), this.stallMs);

    log.info({ stallMs: this.stallMs }, "Outbox processor started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const [, timer] of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    if (this.subscriber) {
      const sub = this.subscriber;
      this.subscriber = null;
      try {
        await Promise.race([
          (async () => {
            try {
              await sub.unlistenAll();
            } catch {}
            await sub.close();
          })(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      } catch {
        // Ignore errors during shutdown
      }
    }

    this.subscribedChannels.clear();
    this.batches.clear();
    this.sweepRun = null;
    log.info("Outbox processor stopped");
  }

  async subscribeAccount(accountId: string): Promise<void> {
    const channel = `outbox_${accountId}`;

    if (!this.subscribedChannels.has(channel) && this.subscriber) {
      this.subscriber.notifications.on(channel, () => {
        this.scheduleBatch(accountId);
      });
      await this.subscriber.listenTo(channel);
      this.subscribedChannels.add(channel);
    }

    if (!this.pollTimers.has(accountId)) {
      const timer = setInterval(() => {
        this.scheduleBatch(accountId);
      }, this.pollIntervalMs);
      this.pollTimers.set(accountId, timer);
    }

    this.scheduleBatch(accountId);
  }

  async unsubscribeAccount(accountId: string): Promise<void> {
    const channel = `outbox_${accountId}`;

    if (this.subscribedChannels.has(channel) && this.subscriber) {
      await this.subscriber.unlisten(channel);
      this.subscribedChannels.delete(channel);
    }

    const timer = this.pollTimers.get(accountId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(accountId);
    }
  }

  private scheduleBatch(accountId: string): void {
    if (!this.running) return;

    const inFlight = this.batches.get(accountId);
    if (inFlight) {
      const idleMs = Date.now() - inFlight.progressAt;
      if (idleMs < this.stallMs) return;
      this.abandon(accountId, inFlight, idleMs);
    }

    // The connection can drop and come back while the account stays subscribed, and an
    // append attempted in that window fails -- or, from ImapFlow, silently does nothing.
    if (!this.isReady(accountId)) return;

    const run: BatchRun = {
      progressAt: Date.now(),
      abandoned: false,
      unstarted: new Set(),
      current: null,
    };
    this.batches.set(accountId, run);
    this.processBatch(accountId, run)
      .catch((err) => {
        log.error({ err, accountId }, "Outbox batch processing failed");
      })
      .finally(() => {
        if (this.batches.get(accountId) === run) this.batches.delete(accountId);
        if (run.abandoned) {
          log.warn(
            { accountId, settledAfterMs: Date.now() - run.progressAt },
            "Abandoned outbox batch settled",
          );
        }
      });
  }

  private isReady(accountId: string): boolean {
    try {
      return this.getImapClient(accountId).isConnected();
    } catch {
      return false;
    }
  }

  /**
   * Give up on a batch that stopped making progress. Its in-flight entry is left to it --
   * that entry may be mid-send, and a second attempt could deliver the mail twice -- while
   * the rows it never started are returned to the queue for a fresh batch.
   */
  private abandon(accountId: string, run: BatchRun, idleMs: number): void {
    run.abandoned = true;
    this.batches.delete(accountId);
    const released = [...run.unstarted];
    run.unstarted.clear();

    log.error(
      { accountId, stalledForMs: idleMs, inFlightEntryId: run.current, released: released.length },
      "Outbox batch made no progress, abandoning it",
    );

    if (released.length === 0) return;
    this.releaseClaims(released)
      .then(() => this.scheduleBatch(accountId))
      .catch((err) => {
        log.error(
          { err, accountId, entryIds: released },
          "Failed to return a stalled batch's rows to the queue",
        );
      });
  }

  /** Put claimed rows nobody has started back in the queue. */
  private async releaseClaims(ids: string[]): Promise<void> {
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("outbox")
        .set({ status: "pending" })
        .where("id", "in", ids)
        .where("status", "=", "processing")
        .execute(),
    );
  }

  private scheduleSweep(): void {
    if (!this.running) return;

    if (this.sweepRun) {
      const idleMs = Date.now() - this.sweepRun.startedAt;
      if (idleMs < this.stallMs) return;
      log.error({ stalledForMs: idleMs }, "Outbox watchdog sweep made no progress");
    }

    const run = { startedAt: Date.now() };
    this.sweepRun = run;
    this.sweep()
      .catch((err) => {
        log.error({ err }, "Outbox watchdog sweep failed");
      })
      .finally(() => {
        if (this.sweepRun === run) this.sweepRun = null;
      });
  }

  /**
   * The backstop for whatever the per-account wakeups miss. A row due for longer than the
   * stall bound means no wakeup reached it -- a lost timer or LISTEN, a stalled batch, an
   * account whose connection is down -- so each is reported, and an account that could
   * send is given a batch. A row left in `processing` that long is reported too; it is not
   * reclaimed, because its attempt may still complete.
   */
  private async sweep(): Promise<void> {
    const stallSeconds = this.stallMs / 1_000;

    const overdue = await sql<{ account_id: string; waiting: number; due_since: Date }>`
      SELECT o.account_id, count(*)::int AS waiting, min(o.next_retry_at) AS due_since
      FROM outbox o
      JOIN accounts a ON a.id = o.account_id
      WHERE a.is_active
        AND o.status IN ('pending', 'failed')
        AND o.next_retry_at <= now() - make_interval(secs => ${stallSeconds})
      GROUP BY o.account_id
    `.execute(this.db);

    const waiting = new Set<string>();
    for (const row of overdue.rows) {
      const detail = { accountId: row.account_id, waiting: row.waiting, dueSince: row.due_since };
      if (this.isReady(row.account_id)) {
        log.error(detail, "Outbox rows overdue on a connected account");
        this.scheduleBatch(row.account_id);
      } else {
        waiting.add(row.account_id);
        if (!this.reportedWaiting.has(row.account_id)) {
          log.warn(detail, "Outbox rows waiting for an account whose IMAP connection is down");
        }
      }
    }
    this.reportedWaiting = waiting;

    const stuck = await sql<{ id: string; account_id: string; kind: string; updated_at: Date }>`
      SELECT id, account_id, kind, updated_at
      FROM outbox
      WHERE status = 'processing'
        AND updated_at <= now() - make_interval(secs => ${stallSeconds})
    `.execute(this.db);

    const stuckIds = new Set<string>();
    for (const row of stuck.rows) {
      stuckIds.add(row.id);
      if (this.reportedStuck.has(row.id)) continue;
      log.error(
        {
          entryId: row.id,
          accountId: row.account_id,
          kind: row.kind,
          processingSince: row.updated_at,
        },
        "Outbox entry stuck in processing",
      );
    }
    this.reportedStuck = stuckIds;
  }

  /**
   * Synchronously process ALL pending outbox rows for an account until the queue is
   * empty. Does not require start() -- works directly against the database, SMTP and
   * IMAP. Returns the total number of rows processed.
   */
  async drain(accountId: string): Promise<number> {
    const wasRunning = this.running;
    this.running = true;
    try {
      let total = 0;
      while (true) {
        const processed = await this.processBatch(accountId);
        if (processed === 0) break;
        total += processed;
      }
      return total;
    } finally {
      this.running = wasRunning;
    }
  }

  private async processBatch(accountId: string, run?: BatchRun): Promise<number> {
    // Same claim pattern as OutboundProcessor: SELECT ... FOR UPDATE SKIP LOCKED and the
    // status='processing' mark run in one transaction so the row lock covers both. It's
    // a sync-engine write (PostIMAP claiming its own queue), so it's tagged accordingly
    // for the postimap_events origin field.
    const claimed = await withSyncWriter(this.db, async (trx) => {
      const rows = await sql<OutboxRow>`
        SELECT id, account_id, kind, from_addr, to_addrs, cc_addrs, bcc_addrs, subject,
               body_text, body_html, in_reply_to, "references", status, attempts,
               max_attempts, sent_message_id, replaces_message_id
        FROM outbox
        WHERE account_id = ${accountId}
          AND status IN ('pending', 'failed')
          AND next_retry_at <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${sql.lit(BATCH_SIZE)}
      `.execute(trx);

      if (rows.rows.length === 0) return [];

      await trx
        .updateTable("outbox")
        .set({ status: "processing" })
        .where(
          "id",
          "in",
          rows.rows.map((r) => r.id),
        )
        .execute();

      return rows.rows;
    });

    if (claimed.length === 0) return 0;

    if (run?.abandoned) {
      // Claimed after the watchdog gave up on this batch, so no unstarted set holds these
      // rows and nothing else would ever hand them back.
      await this.releaseClaims(claimed.map((r) => r.id));
      return 0;
    }
    if (run) {
      run.progressAt = Date.now();
      for (const entry of claimed) run.unstarted.add(entry.id);
    }

    log.debug({ accountId, count: claimed.length }, "Processing outbox batch");

    for (const entry of claimed) {
      if (!this.running) break;
      if (run) {
        // Abandoned while the previous entry was in flight: the rest were already returned
        // to the queue, and a fresh batch may own them by now.
        if (run.abandoned) break;
        run.unstarted.delete(entry.id);
        run.current = entry.id;
      }
      await this.processEntry(entry);
      if (run) {
        run.current = null;
        run.progressAt = Date.now();
      }
    }

    return claimed.length;
  }

  private async processEntry(entry: OutboxRow): Promise<void> {
    const account = await this.db
      .selectFrom("accounts")
      .select(["imap_user", "smtp_host", "smtp_port", "smtp_user", "smtp_password"])
      .where("id", "=", entry.account_id)
      .executeTakeFirst();

    if (!account) {
      await this.markDead(entry, "Account no longer exists");
      return;
    }

    const attachmentRows = await this.db
      .selectFrom("outbox_attachments")
      .select(["filename", "content_type", "data", "content_id"])
      .where("outbox_id", "=", entry.id)
      .execute();

    // Reusing a previously-generated Message-ID (set the moment SMTP send succeeded,
    // see below) makes a retry after a failed APPEND resumable without composing a
    // different message -- and, combined with the alreadySent check, without resending.
    const mailOptions: Mail.Options = {
      from: entry.from_addr ?? account.imap_user,
      to: emptyToUndefined(toAddressArray(entry.to_addrs)),
      cc: emptyToUndefined(toAddressArray(entry.cc_addrs)),
      bcc: emptyToUndefined(toAddressArray(entry.bcc_addrs)),
      subject: entry.subject ?? undefined,
      text: entry.body_text ?? undefined,
      html: entry.body_html ?? undefined,
      inReplyTo: entry.in_reply_to ?? undefined,
      references: entry.references ?? undefined,
      messageId: entry.sent_message_id ?? undefined,
      // cid set moves the attachment into a multipart/related node with
      // Content-Disposition: inline, so a body_html reference to "cid:<content_id>"
      // resolves to it. A row with no content_id composes exactly as before -- an
      // ordinary attachment.
      attachments: attachmentRows.map((a) => ({
        filename: a.filename ?? undefined,
        contentType: a.content_type ?? undefined,
        content: a.data ?? Buffer.alloc(0),
        cid: a.content_id ?? undefined,
      })),
    };

    let raw: Buffer;
    let envelope: { from: string | false; to: string[] };
    let messageId: string;
    try {
      const composed = new MailComposer(mailOptions).compile();
      raw = await composed.build();
      envelope = composed.getEnvelope();
      messageId = composed.messageId();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markDead(entry, `Failed to compose message: ${msg}`);
      return;
    }

    const alreadySent = entry.sent_message_id !== null;
    // Captured here rather than narrowed inline at the transporter below: that use sits
    // in a second, separate block once the folder lookup comes between them, and the two
    // blocks share this same guard.
    let smtp: { host: string; port: number } | null = null;

    if (entry.kind === "send" && !alreadySent) {
      if (!account.smtp_host || !account.smtp_port) {
        await this.markDead(entry, "No SMTP settings configured for this account");
        return;
      }
      smtp = { host: account.smtp_host, port: account.smtp_port };
    }

    // Resolved before the SMTP step, not after it: once the message leaves over SMTP it
    // cannot be un-sent, so a missing Sent/Drafts folder has to dead-letter the entry
    // before that point rather than after -- the alternative is a mail the recipient has
    // and a user told the send failed.
    const targetSpecialUse = entry.kind === "draft" ? "drafts" : "sent";
    const folder = await this.db
      .selectFrom("folders")
      .select(["imap_name"])
      .where("account_id", "=", entry.account_id)
      .where("special_use", "=", targetSpecialUse)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (!folder) {
      const error = `No ${targetSpecialUse} folder known for this account`;
      if (alreadySent) {
        // The message already left over SMTP on an earlier attempt; that cannot be
        // undone by dead-lettering the entry now, and retrying this row would resend it.
        // The send itself succeeded, so say so, distinctly from a failed send.
        await this.markSentWithoutCopy(entry, entry.sent_message_id as string, error);
      } else {
        await this.markDead(entry, error);
      }
      return;
    }

    if (entry.kind === "send" && !alreadySent) {
      // Set above, guarded by the same condition -- the only way to reach this block
      // without it set is a return already having happened.
      const { host, port } = smtp as { host: string; port: number };
      try {
        const transporter = createTransport({
          host,
          port,
          secure: port === 465,
          auth: account.smtp_user
            ? {
                user: account.smtp_user,
                pass: decryptPassword(
                  account.smtp_password ?? Buffer.from([0x00]),
                  this.encryptionKey,
                ),
              }
            : undefined,
        });
        await transporter.sendMail({ envelope, raw });
        transporter.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, entryId: entry.id }, "SMTP send failed");
        await this.markFailed(entry, msg);
        return;
      }

      // Durable checkpoint: a crash or APPEND failure from here on must not resend --
      // the next attempt sees sent_message_id set and skips straight to APPEND, reusing
      // the same Message-ID so both paths stay consistent. Mutated on the local object
      // too, so the APPEND failure branch below sees it within this same call.
      await withSyncWriter(this.db, (trx) =>
        trx
          .updateTable("outbox")
          .set({ sent_message_id: messageId })
          .where("id", "=", entry.id)
          .execute(),
      );
      entry.sent_message_id = messageId;
    }

    try {
      const client = this.getImapClient(entry.account_id);
      const flags = entry.kind === "draft" ? ["\\Seen", "\\Draft"] : ["\\Seen"];
      const appended = await client.client.append(folder.imap_name, raw, flags);
      // ImapFlow resolves rather than rejects when the connection is in no state to append
      // -- mid-reconnect, say -- and then nothing reached the server.
      if (!appended) throw new Error("IMAP connection not ready, message was not appended");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, entryId: entry.id }, "IMAP APPEND failed");
      await this.markFailed(entry, msg);
      return;
    }

    await this.markSent(entry, messageId);
  }

  private async markSent(entry: OutboxRow, messageId: string): Promise<void> {
    await withSyncWriter(this.db, async (trx) => {
      await trx
        .updateTable("outbox")
        .set({
          status: "sent",
          sent_message_id: messageId,
          sent_at: entry.kind === "send" ? new Date() : null,
          error: null,
        })
        .where("id", "=", entry.id)
        .execute();

      // Same transaction as the completion mark, so the two halves of an edit cannot
      // disagree: either this row is done and the message it supersedes is on its way
      // out, or neither happened and the entry is retried.
      await this.supersede(trx, entry);
    });
  }

  /**
   * Terminal state for a `send` whose SMTP delivery already succeeded but whose Sent
   * copy did not -- a folder that went missing, or an APPEND that never recovers before
   * retries run out. The mail already reached the recipient, so resending it would
   * duplicate it: the row is done, marked `sent` rather than `dead`, and the
   * notification says exactly what is missing rather than reading as a failed send.
   */
  private async markSentWithoutCopy(
    entry: OutboxRow,
    sentMessageId: string,
    error: string,
  ): Promise<void> {
    await withSyncWriter(this.db, async (trx) => {
      await trx
        .updateTable("outbox")
        .set({ status: "sent", sent_message_id: sentMessageId, sent_at: new Date(), error })
        .where("id", "=", entry.id)
        .execute();

      // The send genuinely reached the server, so anything this entry was meant to
      // replace is superseded either way.
      await this.supersede(trx, entry);
    });

    try {
      await withSyncWriter(this.db, (trx) =>
        trx
          .insertInto("sync_notifications")
          .values({
            account_id: entry.account_id,
            action: "sent_copy",
            outbox_id: entry.id,
            error,
            detail: {
              attempts: entry.attempts + 1,
              subject: entry.subject ?? null,
              to: entry.to_addrs ?? null,
            },
          })
          .execute(),
      );
    } catch (err) {
      log.error({ err, entryId: entry.id }, "Failed to record a sent-without-copy notification");
    }

    log.error(
      { entryId: entry.id, error },
      "Outbox entry sent over SMTP but its Sent-folder copy could not be saved",
    );
  }

  /**
   * Remove the message this entry replaces, now that its replacement exists on the server.
   *
   * The removal is enqueued rather than performed here: `sync_queue` already carries the
   * retry, the dead-lettering and the `sync_notifications` row a server refusal deserves,
   * and it is the same `delete` a consumer's own `expunged_at` write produces. The insert
   * is explicit because the enclosing transaction is a sync-engine write, so the trigger
   * that would otherwise enqueue it correctly skips -- writing it by hand is what keeps
   * the resulting event honest about who asked for the deletion.
   */
  private async supersede(trx: Kysely<Database>, entry: OutboxRow): Promise<void> {
    if (!entry.replaces_message_id) return;

    const superseded = await trx
      .selectFrom("messages")
      .innerJoin("folders", "folders.id", "messages.folder_id")
      .select([
        "messages.id",
        "messages.folder_id",
        "messages.imap_uid",
        "messages.expunged_at",
        "messages.is_draft",
        "folders.special_use",
      ])
      .where("messages.id", "=", entry.replaces_message_id)
      // Scoped to the entry's own account: `replaces_message_id` is consumer-written and
      // the foreign key alone does not stop it naming another account's message.
      .where("messages.account_id", "=", entry.account_id)
      .executeTakeFirst();

    if (!superseded || superseded.expunged_at) return;

    // The contract restricts this to a message the app could plausibly have composed as
    // a draft. Naming an ordinary message here -- the outbox insert carries no auth of
    // any kind -- has to be ignored rather than honoured, or it is a one-row DELETE of
    // any message in the account.
    if (!superseded.is_draft && superseded.special_use !== "drafts") {
      log.warn(
        { entryId: entry.id, supersededId: superseded.id },
        "replaces_message_id names a message that is not a draft, ignoring",
      );
      return;
    }

    await trx
      .updateTable("messages")
      .set({ expunged_at: new Date() })
      .where("id", "=", superseded.id)
      .execute();

    await trx
      .insertInto("sync_queue")
      .values({
        account_id: entry.account_id,
        message_id: superseded.id,
        action: "delete",
        payload: sql`jsonb_build_object('imap_uid', ${superseded.imap_uid}::text, 'folder_id', ${superseded.folder_id}::uuid)`,
      })
      .execute();

    log.info(
      { entryId: entry.id, supersededId: superseded.id },
      "Draft superseded, expunge enqueued",
    );
  }

  private async markFailed(entry: OutboxRow, error: string): Promise<void> {
    const attempts = entry.attempts + 1;

    if (attempts >= entry.max_attempts) {
      // A `send` whose SMTP delivery already succeeded (checked via sent_message_id,
      // not entry.kind alone -- a draft's is always null) cannot be retried into `dead`:
      // the mail already left, and dead-lettering it here reads as a failure it wasn't.
      if (entry.kind === "send" && entry.sent_message_id !== null) {
        await this.markSentWithoutCopy(entry, entry.sent_message_id, error);
      } else {
        await this.markDead(entry, error);
      }
      return;
    }

    const delayMs = computeDelay(attempts, {
      maxRetries: entry.max_attempts,
      baseDelay: 1_000,
      maxDelay: 300_000,
      jitter: true,
    });

    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("outbox")
        .set({ status: "failed", attempts, error, next_retry_at: new Date(Date.now() + delayMs) })
        .where("id", "=", entry.id)
        .execute(),
    );

    log.warn({ entryId: entry.id, attempts, error }, "Outbox entry failed, will retry");
  }

  private async markDead(entry: OutboxRow, error: string): Promise<void> {
    await withSyncWriter(this.db, (trx) =>
      trx
        .updateTable("outbox")
        .set({ status: "dead", attempts: entry.attempts + 1, error })
        .where("id", "=", entry.id)
        .execute(),
    );

    // A send that never left is the failure a user most wants told about, and the outbox
    // row alone only says so to whoever thinks to look at it.
    try {
      await withSyncWriter(this.db, (trx) =>
        trx
          .insertInto("sync_notifications")
          .values({
            account_id: entry.account_id,
            action: entry.kind === "draft" ? "draft" : "send",
            outbox_id: entry.id,
            error,
            detail: {
              attempts: entry.attempts + 1,
              subject: entry.subject ?? null,
              to: entry.to_addrs ?? null,
            },
          })
          .execute(),
      );
    } catch (err) {
      log.error({ err, entryId: entry.id }, "Failed to record a dead-lettered send");
    }

    log.error({ entryId: entry.id, kind: entry.kind, error }, "Outbox entry dead-lettered");
  }
}

function emptyToUndefined(addrs: string[]): string[] | undefined {
  return addrs.length > 0 ? addrs : undefined;
}
