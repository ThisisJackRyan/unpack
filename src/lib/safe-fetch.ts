import "server-only";
import http from "node:http";
import https from "node:https";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import { FetchArticleError } from "./fetch-errors";
import {
  checkRedirect,
  checkUrl,
  createGuardedLookup,
  DEFAULT_ADDRESS_POLICY,
  type AddressPolicy,
  type Resolver,
} from "./url-guard";

// Server-only: fetches one HTML page from a public web server for the
// add-reading form. Uses node:http(s) rather than global fetch so the socket
// connects through url-guard's lookup (see createGuardedLookup). Redirects
// are followed by hand and each hop is checked again.

export const FETCH_DEADLINE_MS = 8_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

const HTML_TYPES = ["text/html", "application/xhtml+xml"];

const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "user-agent": "unpack-reader/1.0",
};

export type SafeFetchOptions = {
  deadlineMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  // Tests swap in a fake resolver; the app uses DNS.
  resolver?: Resolver;
  // TEST ONLY. Lets the end-to-end tests reach a node:http server on
  // 127.0.0.1 and an ephemeral port, which the default policy blocks.
  // safeFetch throws if this is set and NODE_ENV isn't "test". Next builds
  // and runs the app with NODE_ENV "production" or "development" (and
  // inlines it), so no app code path can turn this on, and the server
  // action never passes it: fetchArticle's options type leaves it out.
  // node:test doesn't set NODE_ENV, so the test file sets it.
  unsafeTestAddressPolicy?: AddressPolicy;
};

function addressPolicy(options: SafeFetchOptions): AddressPolicy {
  const policy = options.unsafeTestAddressPolicy;
  if (!policy) return DEFAULT_ADDRESS_POLICY;
  if (process.env.NODE_ENV !== "test") {
    throw new Error("unsafeTestAddressPolicy is only allowed in tests");
  }
  return policy;
}

export type FetchedPage = { url: URL; html: string };

export function parseContentType(header: string | undefined): {
  mimeType: string;
  charset: string | undefined;
} {
  const [type = "", ...params] = (header ?? "").split(";");
  let charset: string | undefined;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(param);
    if (match) charset = match[1].toLowerCase();
  }
  return { mimeType: type.trim().toLowerCase(), charset };
}

export function isHtmlType(mimeType: string): boolean {
  return HTML_TYPES.includes(mimeType);
}

// How many bytes to search for a <meta> charset, as browsers do.
const META_SNIFF_BYTES = 1024;

// The WHATWG encoding name for a label, or undefined if TextDecoder doesn't
// know it.
function encodingFor(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

// The charset a <meta charset> or <meta http-equiv="Content-Type"
// content="...; charset=..."> declares in the first 1024 bytes, read as
// latin1 (labels are ASCII). Comments are skipped.
export function metaCharset(body: Uint8Array): string | undefined {
  const head = Buffer.from(body.subarray(0, META_SNIFF_BYTES))
    .toString("latin1")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const [tag] of head.matchAll(/<meta[\s/][^>]*>?/gi)) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(
      /([a-z-]+)\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]+))/gi,
    )) {
      const name = m[1].toLowerCase();
      if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
    }
    let label = attrs.get("charset");
    if (
      label === undefined &&
      attrs.get("http-equiv")?.toLowerCase() === "content-type"
    ) {
      label = /charset\s*=\s*["']?([^"';\s]+)/i.exec(attrs.get("content") ?? "")?.[1];
    }
    const encoding = encodingFor(label?.trim());
    if (encoding) {
      // A page can't really be UTF-16 if its meta tag was readable as
      // ASCII, so browsers read it as UTF-8.
      return encoding.startsWith("utf-16") ? "utf-8" : encoding;
    }
  }
  return undefined;
}

// Picks the charset in the HTML spec's order: a byte order mark, then the
// Content-Type header, then a <meta> tag in the first 1024 bytes, then
// UTF-8. A label TextDecoder doesn't know counts as no label.
export function sniffCharset(
  body: Uint8Array,
  headerCharset: string | undefined,
): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  return encodingFor(headerCharset) ?? metaCharset(body) ?? "utf-8";
}

// Decodes an HTML body with the charset sniffCharset picks. TextDecoder
// drops the byte order mark.
export function decodeBody(body: Uint8Array, headerCharset: string | undefined): string {
  return new TextDecoder(sniffCharset(body, headerCharset)).decode(body);
}

// Reads a stream into one buffer, failing with "too_large" as soon as it
// passes maxBytes. The caller destroys the stream.
export async function readCapped(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number,
  host?: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) throw new FetchArticleError("too_large", host);
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// Wraps the response in a decompressor for its Content-Encoding. The size
// cap is applied to what comes out, so a small gzip bomb still stops at
// MAX_RESPONSE_BYTES.
export function decompress(
  body: Readable,
  encoding: string | undefined,
  host?: string,
): Readable {
  const name = (encoding ?? "").trim().toLowerCase();
  if (name === "" || name === "identity") return body;
  let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;
  if (name === "gzip" || name === "x-gzip") decoder = zlib.createGunzip();
  else if (name === "deflate") decoder = zlib.createInflate();
  else if (name === "br") decoder = zlib.createBrotliDecompress();
  else throw new FetchArticleError("http_error", host);
  // pipeline passes an error on either side to the other, so a dropped
  // connection fails the read instead of hanging it.
  return pipeline(body, decoder, () => {});
}

function get(
  url: URL,
  lookup: ReturnType<typeof createGuardedLookup>,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      { method: "GET", headers: REQUEST_HEADERS, lookup, signal, agent: false },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

// Fetches an HTML page, following up to maxRedirects redirects, within one
// deadline for the whole thing. Throws FetchArticleError on any failure.
export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {},
): Promise<FetchedPage> {
  const {
    deadlineMs = FETCH_DEADLINE_MS,
    maxBytes = MAX_RESPONSE_BYTES,
    maxRedirects = MAX_REDIRECTS,
  } = options;
  const policy = addressPolicy(options);
  let url = checkUrl(input, policy);
  const lookup = createGuardedLookup(options.resolver, policy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let response: http.IncomingMessage | undefined;
  try {
    for (let redirects = 0; ; redirects++) {
      response = await get(url, lookup, controller.signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        if (redirects >= maxRedirects) {
          throw new FetchArticleError("http_error", url.hostname);
        }
        url = checkRedirect(url, location, policy);
        continue;
      }
      if (status < 200 || status >= 300) {
        throw new FetchArticleError("http_error", url.hostname);
      }
      const { mimeType, charset } = parseContentType(
        response.headers["content-type"],
      );
      if (!isHtmlType(mimeType)) {
        throw new FetchArticleError("not_html", url.hostname);
      }
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new FetchArticleError("too_large", url.hostname);
      }
      const body = await readCapped(
        decompress(response, response.headers["content-encoding"], url.hostname),
        maxBytes,
        url.hostname,
      );
      return { url, html: decodeBody(body, charset) };
    }
  } catch (error) {
    if (error instanceof FetchArticleError) throw error;
    if (controller.signal.aborted) {
      throw new FetchArticleError("timeout", url.hostname, { cause: error });
    }
    throw new FetchArticleError("http_error", url.hostname, { cause: error });
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}
