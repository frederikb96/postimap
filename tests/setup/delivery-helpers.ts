import { connect as tlsConnect } from "node:tls";
import type { ImapFlow } from "imapflow";
import { env } from "./env.js";
import { waitFor } from "./wait-for.js";

export interface DeliverEmailOptions {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Deliver a test email to the mail server's LMTP port (implicit TLS), simulating a
 * message arriving from an external sender. This exists to seed IMAP state the way a
 * real mail transfer agent would -- distinct from PostIMAP's own outbox SMTP send path
 * (`src/sync/outbox.ts`), which this helper has nothing to do with.
 */
export async function deliverTestEmail(opts: DeliverEmailOptions): Promise<void> {
  const socket = tlsConnect({
    host: env.LMTP_HOST,
    port: env.LMTP_PORT,
    rejectUnauthorized: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  const readResponse = (): Promise<string> =>
    new Promise((resolve, reject) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        // A multi-line reply ends on a line whose code is followed by a space, not a dash.
        if (/^\d{3} .*\r\n$/m.test(buf) || /(?:^|\r\n)\d{3} [^\r\n]*\r\n$/.test(buf)) {
          socket.off("data", onData);
          socket.off("error", onError);
          resolve(buf);
        }
      };
      const onError = (err: Error) => {
        socket.off("data", onData);
        reject(err);
      };
      socket.on("data", onData);
      socket.once("error", onError);
    });

  const command = async (line: string): Promise<string> => {
    socket.write(`${line}\r\n`);
    return readResponse();
  };

  const greeting = await readResponse();
  if (!greeting.startsWith("220")) {
    socket.destroy();
    throw new Error(`LMTP greeting failed: ${greeting}`);
  }

  await command("LHLO test.local");
  await command(`MAIL FROM:<${opts.from}>`);
  const rcptResp = await command(`RCPT TO:<${opts.to}>`);
  if (!rcptResp.startsWith("250")) {
    socket.destroy();
    throw new Error(`LMTP RCPT TO failed: ${rcptResp}`);
  }

  const dataResp = await command("DATA");
  if (!dataResp.startsWith("354")) {
    socket.destroy();
    throw new Error(`LMTP DATA failed: ${dataResp}`);
  }

  const body = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    ...(opts.messageId ? [`Message-ID: ${opts.messageId}`] : []),
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references.join(" ")}`] : []),
    "MIME-Version: 1.0",
    opts.html
      ? "Content-Type: text/html; charset=utf-8"
      : "Content-Type: text/plain; charset=utf-8",
    "",
    opts.html ?? opts.text ?? "",
    ".",
    "",
  ].join("\r\n");

  const finalResp = await new Promise<string>((resolve, reject) => {
    socket.write(body, (err) => {
      if (err) reject(err);
    });
    readResponse().then(resolve, reject);
  });
  if (!finalResp.startsWith("250")) {
    socket.destroy();
    throw new Error(`LMTP delivery failed: ${finalResp}`);
  }

  socket.write("QUIT\r\n");
  socket.end();
}

export interface DeliverAndWaitOptions extends DeliverEmailOptions {
  imapClient: ImapFlow;
  folder?: string;
  timeout?: number;
}

/**
 * Deliver a test email via LMTP, then poll IMAP until it arrives in the specified folder.
 */
export async function deliverAndWait(opts: DeliverAndWaitOptions): Promise<void> {
  await deliverTestEmail(opts);

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
