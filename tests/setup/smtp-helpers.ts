import type { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { env } from "./env.js";
import { waitFor } from "./wait-for.js";

export interface DeliverEmailOptions {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /** Optional auth credentials. Defaults to from address with test password. */
  auth?: { user: string; pass: string };
}

/**
 * Deliver a test email via SMTP to the Stalwart test server.
 */
export async function deliverTestEmail(opts: DeliverEmailOptions): Promise<void> {
  const transport = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: false,
    auth: opts.auth ?? { user: opts.from, pass: "testpass123" },
    tls: { rejectUnauthorized: false },
  });

  await transport.sendMail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });

  transport.close();
}

export interface DeliverAndWaitOptions {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  auth?: { user: string; pass: string };
  imapClient: ImapFlow;
  folder?: string;
  timeout?: number;
}

/**
 * Deliver a test email via SMTP, then poll IMAP until it arrives in the specified folder.
 */
export async function deliverAndWait(opts: DeliverAndWaitOptions): Promise<void> {
  await deliverTestEmail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    auth: opts.auth,
  });

  const folder = opts.folder ?? "INBOX";
  await waitFor(
    async () => {
      const lock = await opts.imapClient.getMailboxLock(folder);
      try {
        return opts.imapClient.mailbox && opts.imapClient.mailbox.exists > 0;
      } finally {
        lock.release();
      }
    },
    { timeout: opts.timeout ?? 10_000, interval: 300 },
  );
}
