import http from "node:http";
import https from "node:https";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import { FetchArticleError } from "./fetch-errors";
import { checkRedirect, checkUrl, createGuardedLookup, type Resolver } from "./url-guard";

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
};

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

// Decodes with the charset from Content-Type, or UTF-8 when there is none or
// TextDecoder doesn't know it.
export function decodeBody(body: Uint8Array, charset: string | undefined): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(body);
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
  let url = checkUrl(input);
  const lookup = createGuardedLookup(options.resolver);
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
        url = checkRedirect(url, location);
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
