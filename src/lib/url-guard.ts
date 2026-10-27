import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { FetchArticleError } from "./fetch-errors";

// Server-only: decides which URLs and addresses the article fetcher may
// reach. Only public http(s) hosts on ports 80 and 443 are allowed. The
// check runs on the URL (scheme, port, credentials, host name, IP literal)
// and again on every address DNS returns, inside the socket's own lookup,
// so the address that was checked is the one that gets connected to.

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast 255.255.255.255
];

const BLOCKED_V6: [string, number][] = [
  // ::/128 (unspecified), ::1/128 (loopback), and the deprecated
  // IPv4-compatible ::a.b.c.d form.
  ["::", 96],
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments, incl. Teredo 2001::/32
  ["2001:db8::", 32], // documentation
  ["64:ff9b:1::", 48], // local-use NAT64
  ["fc00::", 7], // unique local, incl. AWS metadata fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, "ipv6");

// Parses an IPv6 address (with an optional trailing dotted IPv4 part) into
// 8 16-bit groups. Returns undefined if it isn't valid IPv6.
function ipv6Groups(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const parts = v4[1].split(".").map(Number);
    tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
    text = text.slice(0, -v4[1].length);
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }
  const toGroups = (s: string) =>
    s === "" ? [] : s.split(":").map((g) => parseInt(g, 16));
  const doubleColon = text.indexOf("::");
  let groups: number[];
  if (doubleColon === -1) {
    groups = [...toGroups(text), ...tail];
  } else {
    const head = toGroups(text.slice(0, doubleColon));
    const rest = toGroups(text.slice(doubleColon + 2));
    const fill = 8 - head.length - rest.length - tail.length;
    groups = [...head, ...Array(fill).fill(0), ...rest, ...tail];
  }
  return groups.length === 8 ? groups : undefined;
}

function v4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

// The IPv4 address carried inside an IPv6 one, for the forms a host could
// route to an internal v4 address: IPv4-mapped ::ffff:0:0/96, NAT64
// 64:ff9b::/96, and 6to4 2002::/16.
export function embeddedIPv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (!g) return undefined;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4FromGroups(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return v4FromGroups(g[6], g[7]);
  }
  if (g[0] === 0x2002) return v4FromGroups(g[1], g[2]);
  return undefined;
}

// True for any address the fetcher must not connect to, and for anything
// that isn't an IP address at all.
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return blockList.check(bare, "ipv4");
  if (family !== 6) return true;
  const embedded = embeddedIPv4(bare);
  if (embedded !== undefined) return isBlockedAddress(embedded);
  const groups = ipv6Groups(bare);
  if (!groups) return true;
  // Zone ids and odd spellings out of the way: check the canonical form.
  const canonical = groups.map((x) => x.toString(16)).join(":");
  return blockList.check(canonical, "ipv6");
}

// Names that point inside a network by convention, and single-label names
// (like "intranet") that only resolve through a local search domain.
export function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, "");
  if (!name || !name.includes(".")) return true;
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    name.endsWith(".internal") ||
    name === "metadata.google.internal"
  );
}

// Checks a URL against every rule that doesn't need DNS. Returns the parsed
// URL, or throws FetchArticleError ("invalid_url" or "blocked").
export function checkUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchArticleError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchArticleError("invalid_url");
  }
  if (url.username || url.password) {
    throw new FetchArticleError("blocked", url.hostname);
  }
  // WHATWG URL drops a port that matches the scheme default, so "" here
  // means 80 for http and 443 for https.
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new FetchArticleError("blocked", url.hostname);
  }
  // WHATWG URL has already turned 2130706433, 0x7f.1, and 017700000001 into
  // 127.0.0.1, and wraps IPv6 in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new FetchArticleError("blocked", host);
  } else if (isBlockedHostname(host)) {
    throw new FetchArticleError("blocked", host);
  }
  return url;
}

// Resolves a redirect's Location against the current URL and checks it with
// the same rules as the first URL.
export function checkRedirect(current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new FetchArticleError("http_error", current.hostname);
  }
  return checkUrl(next);
}

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

// A `lookup` for http.request / net.connect. It resolves every address for
// the host and fails if ANY of them is blocked, so a host can't mix one
// public and one private record. The socket then connects to the addresses
// checked here, never to a second, unchecked resolution (DNS rebinding).
export function createGuardedLookup(
  resolver: Resolver = systemResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname)
      .then((all) => {
        const wanted =
          options.family === 4 || options.family === 6
            ? all.filter((a) => a.family === options.family)
            : all;
        if (all.some((a) => isBlockedAddress(a.address))) {
          throw new FetchArticleError("blocked", hostname);
        }
        if (wanted.length === 0) {
          throw new FetchArticleError("http_error", hostname);
        }
        if (options.all) {
          callback(null, wanted);
        } else {
          callback(null, wanted[0].address, wanted[0].family);
        }
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, ""));
  };
}
