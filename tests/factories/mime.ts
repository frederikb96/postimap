export interface SimplePlainEmailOpts {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  date?: string;
  messageId?: string;
}

export function simplePlainEmail(opts: SimplePlainEmailOpts = {}): string {
  const from = opts.from ?? "sender@test.local";
  const to = opts.to ?? "recipient@test.local";
  const subject = opts.subject ?? "Test plain email";
  const date = opts.date ?? new Date().toUTCString();
  const messageId = opts.messageId ?? `<plain-${Date.now()}@test.local>`;
  const body = opts.body ?? "This is a plain text email body.\r\n";

  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${body}`;
}

export interface MultipartHtmlEmailOpts {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
}

export function multipartHtmlEmail(opts: MultipartHtmlEmailOpts = {}): string {
  const from = opts.from ?? "sender@test.local";
  const to = opts.to ?? "recipient@test.local";
  const subject = opts.subject ?? "Test multipart email";
  const date = opts.date ?? new Date().toUTCString();
  const messageId = opts.messageId ?? `<multipart-${Date.now()}@test.local>`;
  const text = opts.text ?? "This is the plain text version.";
  const html = opts.html ?? "<html><body><p>This is the <b>HTML</b> version.</p></body></html>";
  const boundary = "----=_Part_001_boundary";

  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${text}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${html}\r\n--${boundary}--\r\n`;
}

export interface EmailWithAttachmentOpts {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  attachmentFilename?: string;
  attachmentContentType?: string;
  attachmentBase64?: string;
  date?: string;
  messageId?: string;
}

export function emailWithAttachment(opts: EmailWithAttachmentOpts = {}): string {
  const from = opts.from ?? "sender@test.local";
  const to = opts.to ?? "recipient@test.local";
  const subject = opts.subject ?? "Test email with attachment";
  const date = opts.date ?? new Date().toUTCString();
  const messageId = opts.messageId ?? `<attach-${Date.now()}@test.local>`;
  const text = opts.text ?? "Please see the attached file.";
  const filename = opts.attachmentFilename ?? "test.txt";
  const contentType = opts.attachmentContentType ?? "text/plain";
  const base64Data =
    opts.attachmentBase64 ?? Buffer.from("This is a test attachment content.").toString("base64");
  const boundary = "----=_Part_002_boundary";

  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${text}\r\n--${boundary}\r\nContent-Type: ${contentType}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Data}\r\n--${boundary}--\r\n`;
}

/**
 * Generate a nested multipart email (forwarded message with message/rfc822 encapsulation).
 */
export function nestedMultipartEmail(): string {
  const boundary = "----=_Part_003_boundary";
  const innerMessage =
    "From: original@test.local\r\n" +
    "To: middleman@test.local\r\n" +
    "Subject: Original subject\r\n" +
    "Date: Mon, 01 Jan 2024 00:00:00 +0000\r\n" +
    "Message-ID: <original-001@test.local>\r\n" +
    "MIME-Version: 1.0\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "\r\n" +
    "This is the original message that was forwarded.\r\n";

  return `From: forwarder@test.local\r\nTo: recipient@test.local\r\nSubject: Fwd: Original subject\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <fwd-${Date.now()}@test.local>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee the forwarded message below.\r\n--${boundary}\r\nContent-Type: message/rfc822\r\nContent-Disposition: inline\r\n\r\n${innerMessage}\r\n--${boundary}--\r\n`;
}

/**
 * Generate an email with RFC 2047 encoded Unicode subject and from header.
 */
export function unicodeHeaderEmail(): string {
  // =?UTF-8?B?...?= encoding for "Greetings from Munchen" with umlaut
  const encodedSubject = "=?UTF-8?B?R3LDvMOfZSBhdXMgTcO8bmNoZW4=?=";
  const encodedFrom = "=?UTF-8?B?SsO8cmdlbiBNw7xsbGVy?= <juergen@test.local>";

  return `From: ${encodedFrom}\r\nTo: recipient@test.local\r\nSubject: ${encodedSubject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <unicode-${Date.now()}@test.local>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis email has Unicode headers.\r\n`;
}
