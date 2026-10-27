import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { FetchArticleError } from "./fetch-errors";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch";
import { isBlockedAddress } from "./url-guard";

// End-to-end safeFetch tests over a real socket, against a node:http server
// on 127.0.0.1 and an ephemeral port. The default policy blocks both, so
// these pass safeFetch's test-only unsafeTestAddressPolicy, which allows
// exactly 127.0.0.1 on any port and blocks everything else the app blocks.
// safeFetch refuses that option unless NODE_ENV is "test", and node:test
// doesn't set it, so this file does. Each test file runs in its own process.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const testOptions: SafeFetchOptions = {
  unsafeTestAddressPolicy: {
    isBlockedAddress: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
    allowAnyPort: true,
  },
};

const PAGE = "<!doctype html><html><head><title>Hi</title></head><body><p>Hello from the test server.</p></body></html>";

async function kindOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof FetchArticleError ? error.kind : String(error);
  }
  return undefined;
}

describe("safeFetch against a local server", () => {
  let server: http.Server;
  let base: string;
  const paths: string[] = [];

  function redirect(res: http.ServerResponse, location: string) {
    res.writeHead(302, { location });
    res.end();
  }

  before(async () => {
    server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      paths.push(path);
      const hop = /^\/r(\d+)$/.exec(path);
      if (hop) {
        const n = Number(hop[1]);
        redirect(res, n > 1 ? `/r${n - 1}` : "/ok");
        return;
      }
      switch (path) {
        case "/ok":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE);
          return;
        case "/loop":
          redirect(res, "/loop");
          return;
        case "/to-private":
          redirect(res, "http://10.0.0.1/");
          return;
        case "/to-localhost":
          redirect(res, `http://localhost:${(server.address() as AddressInfo).port}/ok`);
          return;
        case "/pdf":
          res.writeHead(200, { "content-type": "application/pdf" });
          res.end("%PDF-1.7");
          return;
        case "/drip": {
          res.writeHead(200, { "content-type": "text/html" });
          res.write("<html><body>");
          const timer = setInterval(() => res.write("<p>more</p>"), 50);
          res.on("close", () => clearInterval(timer));
          return;
        }
        case "/big": {
          // No Content-Length, so only the streaming cap can stop it.
          res.writeHead(200, { "content-type": "text/html" });
          const chunk = Buffer.alloc(16 * 1024, "a");
          const pump = () => {
            while (!res.destroyed && res.write(chunk));
          };
          res.on("drain", pump);
          pump();
          return;
        }
        case "/gzip":
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          res.end(gzipSync(PAGE));
          return;
        case "/latin1":
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            Buffer.concat([
              Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>caf'),
              Buffer.from([0xe9]),
              Buffer.from("</p></body></html>"),
            ]),
          );
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("blocks 127.0.0.1 without the test policy, before connecting", async () => {
    const before = paths.length;
    assert.equal(await kindOf(safeFetch(`${base}/ok`)), "blocked");
    assert.equal(await kindOf(safeFetch("http://127.0.0.1/ok")), "blocked");
    assert.equal(paths.length, before);
  });

  it("fetches a 200 HTML page", async () => {
    const page = await safeFetch(`${base}/ok`, testOptions);
    assert.equal(page.html, PAGE);
    assert.equal(page.url.href, `${base}/ok`);
  });

  it("follows a 2 hop redirect chain and returns the final URL", async () => {
    const page = await safeFetch(`${base}/r2`, testOptions);
    assert.equal(page.url.href, `${base}/ok`);
    assert.equal(page.html, PAGE);
  });

  it("follows 3 redirects, the cap", async () => {
    const page = await safeFetch(`${base}/r3`, testOptions);
    assert.equal(page.url.href, `${base}/ok`);
  });

  it("fails with http_error on a 4th redirect", async () => {
    const start = paths.length;
    assert.equal(await kindOf(safeFetch(`${base}/r4`, testOptions)), "http_error");
    // r4, r3, r2, r1, and never /ok.
    assert.deepEqual(paths.slice(start), ["/r4", "/r3", "/r2", "/r1"]);
  });

  it("fails with http_error on a redirect loop", async () => {
    assert.equal(await kindOf(safeFetch(`${base}/loop`, testOptions)), "http_error");
  });

  it("blocks a redirect to a blocked address or host", async () => {
    assert.equal(await kindOf(safeFetch(`${base}/to-private`, testOptions)), "blocked");
    assert.equal(await kindOf(safeFetch(`${base}/to-localhost`, testOptions)), "blocked");
  });

  it("rejects a non-HTML Content-Type", async () => {
    assert.equal(await kindOf(safeFetch(`${base}/pdf`, testOptions)), "not_html");
  });

  it("times out on a body that drips past the deadline", async () => {
    const started = Date.now();
    assert.equal(
      await kindOf(safeFetch(`${base}/drip`, { ...testOptions, deadlineMs: 300 })),
      "timeout",
    );
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 2000, `took ${took} ms`);
  });

  it("fails with too_large on a streamed body past maxBytes", async () => {
    assert.equal(
      await kindOf(safeFetch(`${base}/big`, { ...testOptions, maxBytes: 100_000 })),
      "too_large",
    );
  });

  it("decodes a gzip body", async () => {
    const page = await safeFetch(`${base}/gzip`, testOptions);
    assert.equal(page.html, PAGE);
  });

  it("decodes with a <meta charset> when the header has none", async () => {
    const page = await safeFetch(`${base}/latin1`, testOptions);
    assert.match(page.html, /<p>café<\/p>/);
  });
});
