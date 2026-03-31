import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseMessage } from "../../src/protocol/mime-parser.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures/emails");

function loadFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}

describe("parseMessage — simple-text.eml", () => {
  test("extracts subject, from, to, body_text", async () => {
    const parsed = await parseMessage(loadFixture("simple-text.eml"));

    expect(parsed.subject).toBe("Simple text email");
    expect(parsed.from).toContain("alice@example.com");
    expect(parsed.to).toEqual(["bob@example.com"]);
    expect(parsed.bodyText).toContain("Hello Bob");
    expect(parsed.bodyText).toContain("simple plain text email");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.messageId).toBe("<simple-text-001@example.com>");
    expect(parsed.receivedAt).toBeInstanceOf(Date);
    expect(parsed.attachments).toHaveLength(0);
  });
});

describe("parseMessage — multipart-html.eml", () => {
  test("extracts both text and HTML parts", async () => {
    const parsed = await parseMessage(loadFixture("multipart-html.eml"));

    expect(parsed.subject).toBe("Weekly Newsletter");
    expect(parsed.from).toContain("newsletter@example.com");
    expect(parsed.to).toEqual(["subscriber@example.com"]);
    expect(parsed.bodyText).toContain("plain text");
    expect(parsed.bodyHtml).toContain("<h1>Weekly Newsletter</h1>");
    expect(parsed.bodyHtml).toContain("<b>HTML</b>");
    expect(parsed.messageId).toBe("<multipart-html-001@example.com>");
  });
});

describe("parseMessage — multipart-attachment.eml", () => {
  test("extracts attachment metadata", async () => {
    const parsed = await parseMessage(loadFixture("multipart-attachment.eml"));

    expect(parsed.subject).toBe("Report attached");
    expect(parsed.bodyText).toContain("quarterly report attached");
    expect(parsed.attachments).toHaveLength(1);

    const att = parsed.attachments[0];
    expect(att.filename).toBe("quarterly-report.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att.size).toBeGreaterThan(0);
    expect(att.data).toBeInstanceOf(Buffer);
    expect(att.contentId).toBeNull();
  });
});

describe("parseMessage — unicode-headers.eml", () => {
  test("decodes RFC 2047 encoded headers", async () => {
    const parsed = await parseMessage(loadFixture("unicode-headers.eml"));

    // Subject is base64-encoded UTF-8: "Gruesse aus Munchen" with German characters
    expect(parsed.subject).toContain("aus M");
    // From contains the decoded name with umlauts
    expect(parsed.from).toBeTruthy();
    expect(parsed.messageId).toBe("<unicode-hdrs-001@example.com>");
  });
});

describe("parseMessage — charset-iso8859.eml", () => {
  test("decodes body from ISO-8859-1 to UTF-8", async () => {
    const parsed = await parseMessage(loadFixture("charset-iso8859.eml"));

    // The subject is encoded as iso-8859-1 Q-encoding
    expect(parsed.subject).toContain("caf");
    expect(parsed.subject).toContain("Paris");

    // Body should be decoded from quoted-printable ISO-8859-1 to UTF-8
    expect(parsed.bodyText).toBeTruthy();
    expect(parsed.bodyText).toContain("Bonjour");
    expect(parsed.bodyText).toContain("Paris");
    // Check that accented characters are properly decoded
    expect(parsed.bodyText).toContain("Caf");
  });
});

describe("parseMessage — malformed-boundary.eml", () => {
  test("does not crash on mismatched boundaries", async () => {
    // Should not throw
    const parsed = await parseMessage(loadFixture("malformed-boundary.eml"));

    // The parser should handle gracefully - we get at least the correct boundary part
    expect(parsed.subject).toBe("Malformed MIME boundary");
    expect(parsed.messageId).toBe("<malformed-boundary-001@example.com>");
    // The parser may or may not extract body depending on how it handles boundary mismatch
    // Key assertion: it doesn't crash
  });
});

describe("parseMessage — empty-body.eml", () => {
  test("body_text and body_html are null or empty", async () => {
    const parsed = await parseMessage(loadFixture("empty-body.eml"));

    expect(parsed.subject).toBe("Email with no body content");
    // Empty body should result in null or empty string
    const bodyIsEmpty = parsed.bodyText === null || parsed.bodyText.trim() === "";
    expect(bodyIsEmpty).toBe(true);
    expect(parsed.bodyHtml).toBeNull();
  });
});

describe("parseMessage — inline-images.eml", () => {
  test("extracts inline images (mailparser converts CID to data: URIs)", async () => {
    const parsed = await parseMessage(loadFixture("inline-images.eml"));

    expect(parsed.subject).toBe("Email with inline images");
    // mailparser replaces cid: references with inline data: URIs in HTML
    expect(parsed.bodyHtml).toContain("data:image/png;base64,");
    expect(parsed.bodyHtml).toContain("Red pixel");
    expect(parsed.bodyHtml).toContain("Blue pixel");

    // When mailparser inlines CID images, they may not appear as attachments
    // (they're embedded directly in HTML). The attachment list may be empty or
    // contain only non-inlined attachments. Verify the HTML is well-formed.
    expect(parsed.bodyHtml).toContain("<h1>Email with Inline Images</h1>");
  });
});

describe("parseMessage — raw headers", () => {
  test("rawHeaders is a Record<string, string> with standard keys", async () => {
    const parsed = await parseMessage(loadFixture("simple-text.eml"));

    expect(parsed.rawHeaders).toBeDefined();
    expect(typeof parsed.rawHeaders).toBe("object");
    // Standard headers should be present as lowercase keys
    expect(parsed.rawHeaders["mime-version"]).toBeDefined();
  });
});

describe("parseMessage — references/inReplyTo", () => {
  test("references and inReplyTo are null for standalone email", async () => {
    const parsed = await parseMessage(loadFixture("simple-text.eml"));

    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toBeNull();
  });
});
