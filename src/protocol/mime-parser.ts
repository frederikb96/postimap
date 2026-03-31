import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";

export interface ParsedMessage {
  messageId: string | null;
  subject: string | null;
  from: string | null;
  to: string[] | null;
  cc: string[] | null;
  bcc: string[] | null;
  replyTo: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  bodyText: string | null;
  bodyHtml: string | null;
  rawHeaders: Record<string, string>;
  receivedAt: Date | null;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  contentId: string | null;
  size: number;
  data: Buffer;
}

/** Extract email addresses from an AddressObject or array of AddressObject */
function extractAddresses(addr: AddressObject | AddressObject[] | undefined): string[] | null {
  if (!addr) return null;
  const objects = Array.isArray(addr) ? addr : [addr];
  const addresses: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value) {
      if (entry.address) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses.length > 0 ? addresses : null;
}

/** Extract a single address string from an AddressObject */
function extractSingleAddress(addr: AddressObject | undefined): string | null {
  if (!addr) return null;
  return addr.text || null;
}

/** Convert headers Map to a plain JSON object */
function headersToRecord(headers: Map<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (value instanceof Date) {
      result[key] = value.toISOString();
    } else if (typeof value === "object" && value !== null && "text" in value) {
      result[key] = (value as { text: string }).text;
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

/** Normalize references to a string array */
function normalizeReferences(refs: string[] | string | undefined): string[] | null {
  if (!refs) return null;
  if (Array.isArray(refs)) return refs.length > 0 ? refs : null;
  return [refs];
}

/**
 * Parse a raw email message (RFC 2822/MIME) using mailparser.
 * Handles charset encoding, nested multipart, RFC 2047 encoded headers.
 */
export async function parseMessage(rawSource: Buffer): Promise<ParsedMessage> {
  const parsed = await simpleParser(rawSource);

  return {
    messageId: parsed.messageId ?? null,
    subject: parsed.subject ?? null,
    from: extractSingleAddress(parsed.from),
    to: extractAddresses(parsed.to),
    cc: extractAddresses(parsed.cc),
    bcc: extractAddresses(parsed.bcc),
    replyTo: extractSingleAddress(parsed.replyTo),
    inReplyTo: parsed.inReplyTo ?? null,
    references: normalizeReferences(parsed.references),
    bodyText: parsed.text ?? null,
    bodyHtml: parsed.html === false ? null : (parsed.html ?? null),
    rawHeaders: headersToRecord(parsed.headers),
    receivedAt: parsed.date ?? null,
    attachments: parsed.attachments.map((att) => ({
      filename: att.filename ?? null,
      contentType: att.contentType,
      contentId: att.contentId ?? null,
      size: att.size,
      data: att.content,
    })),
  };
}
