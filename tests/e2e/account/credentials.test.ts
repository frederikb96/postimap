import { afterEach, describe, expect, test } from "vitest";
import { decryptPassword } from "../../../src/crypto.js";
import { AccountSync } from "../../../src/sync/account-sync.js";
import type { OutboundProcessor } from "../../../src/sync/outbound.js";
import type { OutboxProcessor } from "../../../src/sync/outbox.js";
import {
  type E2EContext,
  env,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
} from "../../setup/e2e-helpers.js";

let ctx: E2EContext;

afterEach(async () => {
  if (ctx) await teardownE2EContext(ctx);
});

/** Stands in for the shared processors -- this test only exercises account startup. */
function stubProcessor(): OutboundProcessor & OutboxProcessor {
  return {
    subscribeAccount: async () => {},
    unsubscribeAccount: async () => {},
  } as unknown as OutboundProcessor & OutboxProcessor;
}

function buildAccountSync(): AccountSync {
  return new AccountSync(
    ctx.accountId,
    ctx.db,
    {
      SYNC_INTERVAL_SECONDS: 300,
      IDLE_RESTART_SECONDS: 300,
      IMAP_TLS_REJECT_UNAUTHORIZED: false,
      ENCRYPTION_KEY: env.ENCRYPTION_KEY,
      IDLE_FOLDERS: [],
    },
    getDatabaseUrl(ctx.schema),
    stubProcessor(),
    stubProcessor(),
  );
}

async function waitForActive(accountSync: AccountSync): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      const state = accountSync.getState();
      if (state === "active") {
        clearInterval(poll);
        resolve();
      } else if (state === "error" || Date.now() - start > 30_000) {
        clearInterval(poll);
        reject(new Error(`Account did not become active in time (state=${state})`));
      }
    }, 300);
  });
}

async function storedImapPassword(): Promise<Buffer> {
  const [row] = await ctx.pgSql<{ imap_password: Buffer }[]>`
    SELECT imap_password FROM accounts WHERE id = ${ctx.accountId}
  `;
  return row.imap_password;
}

describe("E2E: credentials are encrypted at rest once a key is configured", () => {
  test("a consumer's plaintext credential is encrypted on account start and still logs in", async () => {
    ctx = await setupE2EContext({ emailPrefix: "e2e-creds", skipImap: true });

    // setupE2EContext writes the credential the way a consumer does: format 0x00.
    expect((await storedImapPassword())[0]).toBe(0x00);

    const first = buildAccountSync();
    try {
      await first.start();
      await waitForActive(first);
    } finally {
      await first.stop();
    }

    const stored = await storedImapPassword();
    expect(stored[0]).toBe(0x01);
    expect(decryptPassword(stored, env.ENCRYPTION_KEY)).toBe(ctx.testPassword);

    // The encrypted credential has to survive the next start -- that is the run where a
    // broken re-encryption would surface, as a login failure against the real server.
    const second = buildAccountSync();
    try {
      await second.start();
      await waitForActive(second);
      expect(second.getState()).toBe("active");
    } finally {
      await second.stop();
    }

    // Still exactly one encryption: the second start found nothing left to do.
    expect((await storedImapPassword()).equals(stored)).toBe(true);
  });
});
