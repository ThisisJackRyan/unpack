import { createHash, createHmac } from "node:crypto";

// The join rate limit's keys. Pure (takes a header getter, and the IP
// hash secret can be passed in), so tests don't need next/headers or a
// real secret.

// Used when no IP header is present (local dev, an odd proxy). Every such
// request then shares one IP budget, which fails safe: the per-code limit
// still applies on top.
export const UNKNOWN_IP = "unknown";

// The first non-empty entry of a comma-separated header.
function firstEntry(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

// The client's IP, as a rate-limit key: the first entry of
// x-vercel-forwarded-for, else x-real-ip, else the first hop of
// x-forwarded-for, else UNKNOWN_IP. On Vercel these are set by the
// platform (a client can't spoof them), and x-vercel-forwarded-for is the
// one another proxy in front can't change; behind another proxy, make sure
// it overwrites them. See ipRateLimitKey for how the address is bucketed.
export function clientIpFromHeaders(get: (name: string) => string | null): string {
  const ip =
    firstEntry(get("x-vercel-forwarded-for")) ?? firstEntry(get("x-real-ip")) ?? firstEntry(get("x-forwarded-for"));
  return ip ? ipRateLimitKey(ip) : UNKNOWN_IP;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every((part) => Number(part) <= 255);
}

// The 8 groups of an IPv6 address (each 0 to 0xffff), with "::" expanded
// and a trailing dotted IPv4 part read as the last two groups, or null if
// it isn't a valid address.
function ipv6Groups(s: string): number[] | null {
  let text = s;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const v4 = text.slice(lastColon + 1);
  if (v4.includes(".")) {
    if (!isIpv4(v4)) return null;
    const [a, b, c, d] = v4.split(".").map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    // Keep the colon when it is half of a "::" right before the IPv4 part.
    text = text.slice(0, text[lastColon - 1] === ":" ? lastColon + 1 : lastColon);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups: number[] = [];
  for (const g of [...head, ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }

  const total = groups.length + tail.length;
  if (halves.length === 2) {
    if (total > 7) return null;
    const zeros = new Array<number>(8 - total).fill(0);
    return [...groups.slice(0, head.length), ...zeros, ...groups.slice(head.length), ...tail];
  }
  return total === 8 ? [...groups, ...tail] : null;
}

// Turns a header's IP into the key the per-IP limit counts:
// - Brackets, a port, and an IPv6 zone id ("%eth0") are dropped.
// - IPv4, and IPv4-mapped IPv6 (::ffff:203.0.113.7), is the IPv4 address.
// - Other IPv6 is its /64 ("2001:db8:0:1::/64"). One home or phone usually
//   gets a whole /64, so per-address keys would let one device rotate
//   through billions of them.
// - Anything else that isn't an IP is kept as it is (lowercased), so it
//   still counts against some key.
export function ipRateLimitKey(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  const v4WithPort = /^([\d.]+):\d+$/.exec(ip);
  if (v4WithPort && isIpv4(v4WithPort[1])) ip = v4WithPort[1];
  if (isIpv4(ip)) return ip;
  if (!ip.includes(":")) return ip || UNKNOWN_IP;

  ip = ip.replace(/%.*$/, "");
  // Junk such as "%eth0:1" is empty once the zone id goes: still one key.
  if (!ip) return UNKNOWN_IP;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

// For dev and tests only: the IP hash key outside production, so local
// dev, tests, and scripts/check-student-join.ts run without setup. It is
// public (it's in the repo), so it never protects real addresses;
// production refuses to fall back to it.
export const DEV_JOIN_IP_HASH_SECRET = "dev-only-join-ip-hash-secret-not-for-production";

// The example value in .env.example. Long enough to pass the length
// check, so production refuses it by name (a test keeps the two in step).
export const JOIN_IP_HASH_SECRET_PLACEHOLDER = "replace_me_with_openssl_rand_base64_32";

export const JOIN_IP_HASH_SECRET_MIN_LENGTH = 32;

type Env = Partial<Record<string, string | undefined>>;

// Production is NODE_ENV=production or, on Vercel, VERCEL_ENV=production
// (so a production deployment is held to the rules even if NODE_ENV were
// ever set otherwise).
function isProduction(env: Env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

// What's wrong with JOIN_IP_HASH_SECRET, or null when it's usable. In
// production a missing or short secret, the .env.example placeholder, or
// the public dev secret is a problem; outside production nothing is (the
// dev secret fills in). Names the variable, never its value. The join
// action checks this before any database work (join-config.ts) and tells
// the student joining is turned off.
export function joinIpHashSecretProblem(env: Env = process.env): { missing: string[]; message: string } | null {
  if (!isProduction(env)) return null;
  const secret = env.JOIN_IP_HASH_SECRET;
  if (!secret || secret.length < JOIN_IP_HASH_SECRET_MIN_LENGTH) {
    return {
      missing: ["JOIN_IP_HASH_SECRET"],
      message: `JOIN_IP_HASH_SECRET is missing or shorter than ${JOIN_IP_HASH_SECRET_MIN_LENGTH} characters.`,
    };
  }
  if (secret === JOIN_IP_HASH_SECRET_PLACEHOLDER || secret === DEV_JOIN_IP_HASH_SECRET) {
    return {
      missing: ["JOIN_IP_HASH_SECRET"],
      message: "JOIN_IP_HASH_SECRET is still the example or dev-only value. Set a real secret (openssl rand -base64 32).",
    };
  }
  return null;
}

// The key for hashJoinIp, from JOIN_IP_HASH_SECRET. When
// joinIpHashSecretProblem finds one it throws with the same message, a
// backstop behind the join action's up-front check, so a join still fails
// closed rather than storing weakly keyed hashes.
export function joinIpHashSecret(env: Env = process.env): string {
  const problem = joinIpHashSecretProblem(env);
  if (problem) throw new Error(problem.message);
  return env.JOIN_IP_HASH_SECRET || DEV_JOIN_IP_HASH_SECRET;
}

// Only this keyed hash (HMAC-SHA256 with a server secret) is stored, never
// the raw IP, and only for the join rate limit (see join-rate-limit.ts).
// Keyed, so a leaked join_attempts table can't be reversed by hashing
// every IPv4 address. Rows are deleted by the next join after the
// 10-minute window. Prefixed so it can't match another table's hash of the
// same value.
export function hashJoinIp(ip: string, secret: string = joinIpHashSecret()): string {
  return createHmac("sha256", secret).update(`join-ip:${ip}`, "utf8").digest("hex");
}

// The per-code key, from the normalized code the student typed (which may
// not be a real code). Plain SHA-256: a class code isn't personal data.
export function hashJoinCode(code: string): string {
  return createHash("sha256").update(`join-code:${code}`, "utf8").digest("hex");
}
