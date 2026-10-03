import { Transform } from "node:stream";
import type { AddressObject } from "mailparser";
import { MailParser, simpleParser } from "mailparser";

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

/**
 * Charset name mailparser is told to decode a text part with when the part declares none (or
 * one it cannot decode). It is not a real charset: the decoder returned for it sees the whole
 * part and picks UTF-8 or windows-1252 from the bytes.
 */
const AUTO_CHARSET = "x-auto-utf8-or-windows-1252";

/**
 * Decodes a text part declared with no usable charset the way mail clients do: valid UTF-8 is
 * kept byte-for-byte, anything else is read as windows-1252 (a superset of Latin-1).
 */
class AutoCharsetDecoder extends Transform {
  private readonly chunks: Buffer[] = [];

  override _transform(chunk: Buffer, _encoding: string, done: () => void): void {
    this.chunks.push(chunk);
    done();
  }

  override _flush(done: (err?: Error | null, data?: Buffer) => void): void {
    const bytes = Buffer.concat(this.chunks);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      done(null, bytes);
    } catch {
      done(null, Buffer.from(new TextDecoder("windows-1252").decode(bytes), "utf-8"));
    }
  }
}

// mailparser decodes a text part without a charset parameter as UTF-8 and has no option to
// change that, so the fallback hooks its two internal seams: createNode() marks such parts, and
// the decoder factory answers the marker (and any charset it cannot decode) with the decoder above.
interface MailParserInternals {
  createNode(node: { contentType?: string; charset?: string }): { charset?: string };
  getDecoder(): { decodeStream(charset: string): Transform };
}

const internals = MailParser.prototype as unknown as MailParserInternals;
const originalCreateNode = internals.createNode;
const originalGetDecoder = internals.getDecoder;
if (typeof originalCreateNode !== "function" || typeof originalGetDecoder !== "function") {
  throw new Error("mailparser internals changed: charset fallback cannot be installed");
}

internals.createNode = function createNode(this: unknown, node) {
  const created = originalCreateNode.call(this, node);
  if (!node.charset && node.contentType?.toLowerCase().startsWith("text/")) {
    created.charset = AUTO_CHARSET;
  }
  return created;
};

internals.getDecoder = function getDecoder(this: unknown) {
  const decoder = originalGetDecoder.call(this);
  const decodeStream = decoder.decodeStream.bind(decoder);
  decoder.decodeStream = (charset: string) => {
    if (charset === AUTO_CHARSET) return new AutoCharsetDecoder();
    try {
      return decodeStream(charset);
    } catch {
      return new AutoCharsetDecoder();
    }
  };
  return decoder;
};

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
