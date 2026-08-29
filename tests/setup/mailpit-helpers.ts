import { env } from "./env.js";
import { waitFor } from "./wait-for.js";

function baseUrl(): string {
  return `http://${env.MAILPIT_HOST}:${env.MAILPIT_HTTP_PORT}`;
}

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessageSummary {
  ID: string;
  MessageID: string;
  From: MailpitAddress | null;
  To: MailpitAddress[];
  Subject: string;
  Snippet: string;
  Attachments: number;
}

export interface MailpitMessage extends Omit<MailpitMessageSummary, "Attachments" | "Snippet"> {
  Text: string;
  HTML: string;
  Attachments: Array<{ FileName: string; ContentType: string; Size: number }>;
}

/** List every message currently held by the test Mailpit instance. */
export async function listMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${baseUrl()}/api/v1/messages`);
  if (!res.ok) {
    throw new Error(`Mailpit /api/v1/messages returned ${res.status}`);
  }
  const body = (await res.json()) as { messages: MailpitMessageSummary[] };
  return body.messages;
}

/** Fetch the full message (body, headers, attachments) by Mailpit's own ID. */
export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${baseUrl()}/api/v1/message/${id}`);
  if (!res.ok) {
    throw new Error(`Mailpit /api/v1/message/${id} returned ${res.status}`);
  }
  return (await res.json()) as MailpitMessage;
}

/** Deletes every message Mailpit is holding, for isolation between test files. */
export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${baseUrl()}/api/v1/messages`, { method: "DELETE" });
}

/**
 * Polls Mailpit until a message with the given subject shows up (proving PostIMAP
 * actually delivered it over SMTP), then returns its full detail.
 */
export async function waitForMailpitMessage(
  subject: string,
  timeout = 10_000,
): Promise<MailpitMessage> {
  let found: MailpitMessageSummary | undefined;
  await waitFor(
    async () => {
      const messages = await listMailpitMessages();
      found = messages.find((m) => m.Subject === subject);
      return found !== undefined;
    },
    { timeout, interval: 300 },
  );
  // biome-ignore lint/style/noNonNullAssertion: waitFor only resolves once found is set
  return getMailpitMessage(found!.ID);
}
