import type { Logger } from "pino";

/**
 * One batch in flight for one account, as its processor's stall watchdog sees it.
 *
 * A batch takes each claimed row before touching it -- before the IMAP command and before
 * any write that settles it. Rows it has not taken yet are what the watchdog may hand to
 * another batch once this one stops making progress. Rows it has taken stay with it,
 * because running them a second time could apply them twice.
 */
export class BatchRun {
  progressAt = Date.now();
  abandoned = false;
  /** Claimed rows not taken yet. */
  readonly unstarted = new Set<string>();
  /** The rows being worked on right now. */
  current: string[] = [];

  /**
   * Record freshly claimed rows. False when the watchdog gave up on this batch while the
   * claim was in flight: nobody else knows the rows are taken, so the caller returns them.
   */
  claimed(ids: string[]): boolean {
    if (this.abandoned) return false;
    this.progressAt = Date.now();
    for (const id of ids) this.unstarted.add(id);
    return true;
  }

  /**
   * Take rows before touching them. False once the watchdog has given up on this batch:
   * the rows it had not taken went back to the queue then and may belong to another batch
   * by now, so the caller stops.
   */
  take(ids: string[]): boolean {
    if (this.abandoned) return false;
    for (const id of ids) this.unstarted.delete(id);
    this.current = ids;
    return true;
  }

  done(): void {
    this.current = [];
    this.progressAt = Date.now();
  }
}

export interface OverdueAccount {
  accountId: string;
  waiting: number;
  dueSince: Date;
}

export interface BatchWatchdogOptions {
  /** Starts every message logged, e.g. "Outbox". */
  label: string;
  stallMs: number;
  log: Logger;
  /** Whether a batch could do anything for the account right now. */
  isReady: (accountId: string) => boolean;
  /** Put rows a batch claimed but never took back in the queue. */
  release: (ids: string[]) => Promise<void>;
  /** Start a batch for the account. */
  schedule: (accountId: string) => void;
  /** Active accounts holding rows that have been due for at least `stallSeconds`. */
  overdue: (stallSeconds: number) => Promise<OverdueAccount[]>;
  /** Anything else a sweep reports. */
  sweepExtra?: (stallSeconds: number) => Promise<void>;
}

/**
 * Keeps a processor's per-account batches from wedging it, and reports what nothing
 * picked up.
 *
 * Every wakeup is dropped while an account already has a batch in flight, so a batch that
 * never settles would silence that account until restart. One that makes no progress for
 * `stallMs` is given up on instead: what it took stays with it, what it had not taken goes
 * back to the queue, and a fresh batch takes over. A sweep on the same interval,
 * independent of every per-account wakeup, reports and reschedules any row due for that
 * long -- a lost timer or LISTEN, a stalled batch, an account whose connection is down.
 */
export class BatchWatchdog {
  private runs = new Map<string, BatchRun>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepRun: { startedAt: number } | null = null;
  /** Accounts already reported as holding rows back, so a long outage logs once. */
  private reportedWaiting = new Set<string>();

  constructor(private opts: BatchWatchdogOptions) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.scheduleSweep(), this.opts.stallMs);
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.runs.clear();
    this.sweepRun = null;
  }

  /**
   * A run for a new batch, or null when none should start: the account's current batch is
   * still making progress, or its connection is not up. A batch that stopped making
   * progress is abandoned first.
   */
  begin(accountId: string): BatchRun | null {
    const inFlight = this.runs.get(accountId);
    if (inFlight) {
      const idleMs = Date.now() - inFlight.progressAt;
      if (idleMs < this.opts.stallMs) return null;
      this.abandon(accountId, inFlight, idleMs);
    }

    // The connection can drop and come back while the account stays subscribed, and work
    // attempted in that window only spends retries on an error nobody caused.
    if (!this.opts.isReady(accountId)) return null;

    const run = new BatchRun();
    this.runs.set(accountId, run);
    return run;
  }

  end(accountId: string, run: BatchRun): void {
    if (this.runs.get(accountId) === run) this.runs.delete(accountId);
    if (run.abandoned) {
      this.opts.log.warn(
        { accountId, settledAfterMs: Date.now() - run.progressAt },
        `Abandoned ${this.opts.label.toLowerCase()} batch settled`,
      );
    }
  }

  private abandon(accountId: string, run: BatchRun, idleMs: number): void {
    const { label, log } = this.opts;
    run.abandoned = true;
    this.runs.delete(accountId);
    const released = [...run.unstarted];
    run.unstarted.clear();

    log.error(
      { accountId, stalledForMs: idleMs, inFlight: run.current, released: released.length },
      `${label} batch made no progress, abandoning it`,
    );

    if (released.length === 0) return;
    this.opts
      .release(released)
      .then(() => this.opts.schedule(accountId))
      .catch((err) => {
        log.error(
          { err, accountId, ids: released },
          `Failed to return a stalled ${label.toLowerCase()} batch's rows to the queue`,
        );
      });
  }

  private scheduleSweep(): void {
    const { label, log } = this.opts;
    if (this.sweepRun) {
      const idleMs = Date.now() - this.sweepRun.startedAt;
      if (idleMs < this.opts.stallMs) return;
      log.error({ stalledForMs: idleMs }, `${label} watchdog sweep made no progress`);
    }

    const run = { startedAt: Date.now() };
    this.sweepRun = run;
    this.sweep()
      .catch((err) => {
        log.error({ err }, `${label} watchdog sweep failed`);
      })
      .finally(() => {
        if (this.sweepRun === run) this.sweepRun = null;
      });
  }

  private async sweep(): Promise<void> {
    const { label, log } = this.opts;
    const stallSeconds = this.opts.stallMs / 1_000;

    const waiting = new Set<string>();
    for (const row of await this.opts.overdue(stallSeconds)) {
      // A backlog behind a batch that is still making progress is being worked through,
      // not missed; the stall check owns that batch.
      const inFlight = this.runs.get(row.accountId);
      if (inFlight && Date.now() - inFlight.progressAt < this.opts.stallMs) continue;

      const detail = { accountId: row.accountId, waiting: row.waiting, dueSince: row.dueSince };
      if (this.opts.isReady(row.accountId)) {
        log.error(detail, `${label} rows overdue on a connected account`);
        this.opts.schedule(row.accountId);
      } else {
        waiting.add(row.accountId);
        if (!this.reportedWaiting.has(row.accountId)) {
          log.warn(detail, `${label} rows waiting for an account whose IMAP connection is down`);
        }
      }
    }
    this.reportedWaiting = waiting;

    await this.opts.sweepExtra?.(stallSeconds);
  }
}
