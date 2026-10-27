import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { FetchArticleError } from "./fetch-errors";
import {
  decodeBody,
  decompress,
  isHtmlType,
  metaCharset,
  parseContentType,
  readCapped,
  safeFetch,
  sniffCharset,
} from "./safe-fetch";
import { isBlockedAddress } from "./url-guard";

async function kindOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof FetchArticleError ? error.kind : String(error);
  }
  return undefined;
}

describe("content type", () => {
  it("parses the type and charset", () => {
    assert.deepEqual(parseContentType("text/html; charset=UTF-8"), {
      mimeType: "text/html",
      charset: "utf-8",
    });
    assert.deepEqual(parseContentType('Text/HTML;charset="ISO-8859-1"'), {
      mimeType: "text/html",
      charset: "iso-8859-1",
    });
    assert.deepEqual(parseContentType(undefined), { mimeType: "", charset: undefined });
  });

  it("accepts only HTML types", () => {
    assert.equal(isHtmlType("text/html"), true);
    assert.equal(isHtmlType("application/xhtml+xml"), true);
    for (const type of ["application/pdf", "text/plain", "application/json", "image/png", ""]) {
      assert.equal(isHtmlType(type), false, type);
    }
  });
});

describe("decodeBody", () => {
  it("decodes with the given charset", () => {
    assert.equal(decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1"), "café");
    assert.equal(decodeBody(Buffer.from([0x93, 0x68, 0x69, 0x94]), "windows-1252"), "“hi”");
  });

  it("falls back to UTF-8 when the charset is missing or unknown", () => {
    const utf8 = Buffer.from("café ’", "utf8");
    assert.equal(decodeBody(utf8, undefined), "café ’");
    assert.equal(decodeBody(utf8, "not-a-charset"), "café ’");
  });
});

describe("charset sniffing", () => {
  const latin1Page = (head: string) =>
    Buffer.concat([
      Buffer.from(`<!doctype html><html><head>${head}<title>Menu</title></head><body><p>caf`, "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("</p></body></html>", "latin1"),
    ]);

  it("reads <meta charset> when the header has none", () => {
    const body = latin1Page('<meta charset="windows-1252">');
    assert.equal(sniffCharset(body, undefined), "windows-1252");
    assert.match(decodeBody(body, undefined), /<p>café<\/p>/);
  });

  it("reads <meta http-equiv=Content-Type content=...charset=...>", () => {
    const body = latin1Page(
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=ISO-8859-1">',
    );
    // WHATWG maps iso-8859-1 to windows-1252.
    assert.equal(sniffCharset(body, undefined), "windows-1252");
    assert.match(decodeBody(body, undefined), /<p>café<\/p>/);
    assert.equal(
      metaCharset(Buffer.from("<meta http-equiv=content-type content='text/html;charset=koi8-r'>")),
      "koi8-r",
    );
    assert.equal(metaCharset(Buffer.from("<meta charset=shift_jis>")), "shift_jis");
  });

  it("lets the header charset win over the meta tag", () => {
    const body = Buffer.from('<meta charset="windows-1252"><p>café</p>', "utf8");
    assert.equal(sniffCharset(body, "utf-8"), "utf-8");
    assert.match(decodeBody(body, "utf-8"), /café/);
  });

  it("lets a byte order mark win over the header and the meta tag", () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<meta charset="windows-1252"><p>café</p>')]);
    assert.equal(sniffCharset(utf8, "windows-1252"), "utf-8");
    assert.equal(decodeBody(utf8, "windows-1252"), '<meta charset="windows-1252"><p>café</p>');

    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>café</p>", "utf16le")]);
    assert.equal(sniffCharset(le, "utf-8"), "utf-16le");
    assert.equal(decodeBody(le, "utf-8"), "<p>café</p>");

    const be = Buffer.from([0xfe, 0xff, 0x00, 0x63, 0x00, 0xe9]);
    assert.equal(decodeBody(be, undefined), "cé");
  });

  it("ignores an unknown label and keeps looking, then falls back to UTF-8", () => {
    const body = latin1Page('<meta charset="windows-1252">');
    assert.equal(sniffCharset(body, "no-such-charset"), "windows-1252");
    assert.equal(sniffCharset(Buffer.from('<meta charset="nope"><p>x</p>'), undefined), "utf-8");
    assert.equal(sniffCharset(Buffer.from("<p>no meta</p>"), undefined), "utf-8");
  });

  it("reads a meta UTF-16 label as UTF-8", () => {
    assert.equal(metaCharset(Buffer.from('<meta charset="utf-16">')), "utf-8");
  });

  it("skips comments and looks only at the first 1024 bytes", () => {
    assert.equal(metaCharset(Buffer.from('<!-- <meta charset="koi8-r"> --><p>x</p>')), undefined);
    const late = Buffer.from(`${" ".repeat(1024)}<meta charset="windows-1252">`);
    assert.equal(metaCharset(late), undefined);
  });
});

describe("readCapped", () => {
  it("reads a stream under the cap", async () => {
    const body = await readCapped(Readable.from([Buffer.from("ab"), "cd"]), 4);
    assert.equal(body.toString(), "abcd");
  });

  it("stops with too_large as soon as the cap is passed", async () => {
    let pulled = 0;
    async function* endless() {
      while (true) {
        pulled++;
        yield Buffer.alloc(1024);
      }
    }
    assert.equal(await kindOf(readCapped(endless(), 4096)), "too_large");
    assert.equal(pulled, 5);
  });
});

describe("decompress", () => {
  const html = "<p>hello</p>".repeat(100);

  for (const [encoding, data] of [
    ["gzip", gzipSync(html)],
    ["deflate", deflateSync(html)],
    ["br", brotliCompressSync(html)],
    ["identity", Buffer.from(html)],
    [undefined, Buffer.from(html)],
  ] as const) {
    it(`decodes ${encoding ?? "no encoding"}`, async () => {
      const out = await readCapped(decompress(Readable.from([data]), encoding), 1_000_000);
      assert.equal(out.toString(), html);
    });
  }

  it("applies the cap after decompressing (gzip bomb)", async () => {
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
    assert.ok(bomb.length < 20_000);
    const stream = decompress(Readable.from([bomb]), "gzip");
    assert.equal(await kindOf(readCapped(stream, 2 * 1024 * 1024)), "too_large");
    stream.destroy();
  });

  it("rejects an unknown encoding", () => {
    assert.throws(
      () => decompress(Readable.from([]), "compress"),
      (e) => e instanceof FetchArticleError && e.kind === "http_error",
    );
  });

  it("fails on corrupt data", async () => {
    const stream = decompress(Readable.from([Buffer.from("not gzip")]), "gzip");
    assert.notEqual(await kindOf(readCapped(stream, 1000)), undefined);
  });
});

// These never reach the network: each one fails before a socket connects.
describe("safeFetch", () => {
  it("blocks private URLs before any lookup", async () => {
    let looked = false;
    const resolver = async () => {
      looked = true;
      return [];
    };
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "http://localhost/", "http://0x7f.1/"]) {
      assert.equal(await kindOf(safeFetch(url, { resolver })), "blocked", url);
    }
    assert.equal(await kindOf(safeFetch("ftp://example.com/", { resolver })), "invalid_url");
    assert.equal(looked, false);
  });

  it("blocks a host whose DNS answer is private, inside the real request", async () => {
    const resolver = async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ];
    assert.equal(await kindOf(safeFetch("https://rebind.example.com/", { resolver })), "blocked");
    assert.equal(await kindOf(safeFetch("http://rebind.example.com/", { resolver })), "blocked");
  });

  it("times out when the deadline passes", async () => {
    const resolver = () => new Promise<never>(() => {});
    const started = Date.now();
    assert.equal(
      await kindOf(safeFetch("https://slow.example.com/", { resolver, deadlineMs: 50 })),
      "timeout",
    );
    assert.ok(Date.now() - started < 2000);
  });

  it("refuses the test-only address policy outside NODE_ENV=test", async () => {
    const saved = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      await assert.rejects(
        safeFetch("http://127.0.0.1:1/", {
          unsafeTestAddressPolicy: { isBlockedAddress, allowAnyPort: true },
        }),
        (error) => !(error instanceof FetchArticleError) && /only allowed in tests/.test(String(error)),
      );
    } finally {
      // Assigning undefined to process.env stores the string "undefined".
      if (saved === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = saved;
    }
  });

  it("reports DNS failures as http_error", async () => {
    const resolver = async () => {
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    };
    assert.equal(await kindOf(safeFetch("https://missing.example.com/", { resolver })), "http_error");
  });
});
