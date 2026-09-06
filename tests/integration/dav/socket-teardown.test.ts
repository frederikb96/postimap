import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DavClient } from "../../../src/dav/client.js";
import { isHttpClientAssertion } from "../../../src/util/process-guard.js";

/**
 * A DAV server's response body is what decides whether the HTTP client's response parser
 * pauses under backpressure, and a server that closes the connection instead of keeping it
 * alive is what turns a paused parser into an uncatchable assertion inside the socket's own
 * `end` listener. Both halves are properties of the wire, not of vCard content, so these
 * tests speak HTTP directly rather than going through Radicale -- which keeps neither
 * choice under the test's control.
 */

/** Larger than the response parser's buffer, so a body this size applies backpressure. */
const LARGE_BODY = "x".repeat(96 * 1024);

interface Fixture {
  server: Server;
  url: string;
  connections: number;
}

/**
 * Answers every request with `body`, either keeping the connection alive or closing it.
 * Request framing is only as clever as it needs to be: every request this file sends
 * carries a Content-Length, so a blank line followed by that many bytes is one request.
 */
async function startServer(opts: {
  body: string;
  keepAlive: boolean;
  status?: string;
  extraHeaders?: string[];
}): Promise<Fixture> {
  const fixture = { connections: 0 } as Fixture;
  const server = createServer((sock: Socket) => {
    fixture.connections++;
    let buffered = "";
    sock.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      for (;;) {
        const headEnd = buffered.indexOf("\r\n\r\n");
        if (headEnd === -1) return;
        const head = buffered.slice(0, headEnd);
        const declared = /content-length:\s*(\d+)/i.exec(head);
        const bodyLength = declared ? Number.parseInt(declared[1], 10) : 0;
        const total = headEnd + 4 + bodyLength;
        if (buffered.length < total) return;
        buffered = buffered.slice(total);
        sock.write(
          [
            `HTTP/1.1 ${opts.status ?? "201 Created"}`,
            "Content-Type: text/plain; charset=utf-8",
            `Content-Length: ${opts.body.length}`,
            ...(opts.extraHeaders ?? []),
            opts.keepAlive ? "Connection: keep-alive" : "Connection: close",
            "",
            "",
          ].join("\r\n") + opts.body,
        );
        if (!opts.keepAlive) sock.end();
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.server = server;
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return fixture;
}

function davClient(baseUrl: string): DavClient {
  return new DavClient({
    baseUrl,
    username: "u",
    password: "p",
    tlsRejectUnauthorized: true,
    requestTimeoutMs: 5_000,
  });
}

const CARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:socket-teardown\r\nFN:A\r\nEND:VCARD\r\n";

describe("DavClient against a server that closes every connection", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startServer({
      body: LARGE_BODY,
      keepAlive: false,
      extraHeaders: ['ETag: "etag-1"'],
    });
  });

  afterAll(() => {
    fixture.server.close();
  });

  test("a write whose response carries a large body completes, and the client keeps working", async () => {
    const client = davClient(fixture.url);

    const first = await client.put(`${fixture.url}a.vcf`, CARD, "text/vcard", { create: true });
    expect(first.status).toBe(201);
    expect(first.etag).toBe('"etag-1"');

    const second = await client.delete(`${fixture.url}a.vcf`);
    expect(second.status).toBe(201);
  });
});

describe("DavClient connection reuse", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startServer({ body: LARGE_BODY, keepAlive: true, extraHeaders: ['ETag: "e"'] });
  });

  afterAll(() => {
    fixture.server.close();
  });

  test("a write releases its connection, so later writes reuse it", async () => {
    const client = davClient(fixture.url);

    const writes = 4;
    for (let i = 0; i < writes; i++) {
      await client.put(`${fixture.url}${i}.vcf`, CARD, "text/vcard", { create: true });
    }

    // A response body left unread pins its connection, so every request would open one.
    expect(fixture.connections).toBeLessThan(writes);
  });
});

describe("the process guard against the runtime's own HTTP client", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startServer({ body: LARGE_BODY, keepAlive: false, status: "200 OK" });
  });

  afterAll(() => {
    fixture.server.close();
  });

  test("an unread response body raises nothing the guard fails to recognise", async () => {
    // The test runner installs its own `uncaughtException` listener and fails the file on
    // anything it sees, so collect them here instead and put its listeners back afterwards.
    const suspended = process.listeners("uncaughtException");
    const caught: unknown[] = [];
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", (err) => caught.push(err));
    try {
      await fetch(fixture.url, { method: "REPORT" });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      process.removeAllListeners("uncaughtException");
      for (const listener of suspended) process.on("uncaughtException", listener);
    }

    expect(caught.filter((err) => !isHttpClientAssertion(err))).toEqual([]);
  });
});
