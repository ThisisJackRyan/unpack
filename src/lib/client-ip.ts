import { createHash } from "node:crypto";

// The join rate limit's keys. Pure (takes a header getter), so tests don't
// need next/headers.

// Used when no IP header is present (local dev, an odd proxy). Every such
// request then shares one IP budget, which fails safe: the per-code limit
// still applies on top.
export const UNKNOWN_IP = "unknown";

// The client's IP: the first hop of x-forwarded-for, else x-real-ip, else
// UNKNOWN_IP. On Vercel both headers are set by the platform (a client
// can't spoof them); behind another proxy, make sure it overwrites them.
export function clientIpFromHeaders(get: (name: string) => string | null): string {
  const first = get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first) return first.toLowerCase();
  const real = get("x-real-ip")?.trim();
  if (real) return real.toLowerCase();
  return UNKNOWN_IP;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Only this hash is stored, never the raw IP, and only for the limit
// window (see join-rate-limit.ts). Prefixed so it can't match another
// table's hash of the same value. Unsalted, so it is a short-lived limit
// key, not anonymization: the 10-minute retention is the protection.
export function hashJoinIp(ip: string): string {
  return sha256(`join-ip:${ip}`);
}

// The per-code key, from the normalized code the student typed (which may
// not be a real code).
export function hashJoinCode(code: string): string {
  return sha256(`join-code:${code}`);
}
