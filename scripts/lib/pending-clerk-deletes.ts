// The pure parts of scripts/list-pending-clerk-deletes.ts: argument
// parsing, the report lines, the Clerk paging (shared with
// scripts/lib/roleless-clerk-sweep.ts), and the hash matching.
// Tests cover them (pending-clerk-deletes.test.ts).
//
// Nothing personal is ever printed: a pending row is shown as a short
// prefix of its hash and its age; a Clerk user only as its id (only the
// id and three timestamps, created_at, last_sign_in_at and last_active_at,
// are read from the user object).

import { hashClerkUserId } from "@/lib/deleted-accounts";

// Enough to tell the rows apart; the full hash is never needed by ops.
export const HASH_PREFIX_LENGTH = 12;

// The most the Clerk Backend API returns per page.
export const CLERK_PAGE_SIZE = 500;

export const CLERK_USERS_URL = "https://api.clerk.com/v1/users";

export type PendingRow = { clerk_user_hash: string; deleted_at: Date | string };

export type Options = { matchClerk: boolean };

export const USAGE = "Usage: pnpm ops:list-pending-clerk-deletes [--match-clerk]";

// Only --match-clerk (and --help) are known; anything else is refused.
export function parseOptions(argv: readonly string[]): Options | { error: string } | { help: true } {
  let matchClerk = false;
  for (const arg of argv) {
    if (arg === "--match-clerk") matchClerk = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else return { error: `Unknown argument. ${USAGE}` };
  }
  return { matchClerk };
}

export function hashPrefix(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LENGTH);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ageDays(deletedAt: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(deletedAt).getTime()) / DAY_MS));
}

// The listing: the count, then one line per pending row, oldest first.
export function formatPendingReport(rows: readonly PendingRow[], now: Date): string[] {
  const lines = [`${rows.length} pending Clerk delete${rows.length === 1 ? "" : "s"} (hash listed, Clerk's delete not confirmed)`];
  for (const row of rows) {
    const days = ageDays(row.deleted_at, now);
    const date = new Date(row.deleted_at).toISOString().slice(0, 10);
    lines.push(`  ${hashPrefix(row.clerk_user_hash)}  listed ${date}, ${days} day${days === 1 ? "" : "s"} ago`);
  }
  return lines;
}

// The Clerk ids whose hash is pending, in the order given.
export function matchPendingClerkIds(clerkUserIds: Iterable<string>, pendingHashes: ReadonlySet<string>): string[] {
  const matched: string[] = [];
  for (const id of clerkUserIds) if (pendingHashes.has(hashClerkUserId(id))) matched.push(id);
  return matched;
}

// The matching part of the report: each Clerk id with its row's prefix,
// then the pending rows no Clerk user matched.
export function formatMatchReport(matchedIds: readonly string[], pendingHashes: ReadonlySet<string>): string[] {
  const one = matchedIds.length === 1;
  const lines = [
    `${matchedIds.length} Clerk user${one ? " still exists for a pending row" : "s still exist for pending rows"} (delete each in the Clerk dashboard):`,
  ];
  const found = new Set<string>();
  for (const id of matchedIds) {
    const hash = hashClerkUserId(id);
    found.add(hash);
    lines.push(`  ${id}  (row ${hashPrefix(hash)})`);
  }
  const missing = [...pendingHashes].filter((h) => !found.has(h)).sort();
  if (missing.length > 0) {
    lines.push(`${missing.length} pending row${missing.length === 1 ? " has" : "s have"} no Clerk user (already gone in Clerk; kept, hash only):`);
    for (const hash of missing) lines.push(`  ${hashPrefix(hash)}`);
  }
  return lines;
}

// Our own failure, whose message is safe to print (a status, no body).
export class ClerkListError extends Error {
  name = "ClerkListError";
}

export type FetchLike = (url: string, init: { method?: "DELETE"; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// A Clerk user as the ops scripts see it: the id, when it was created
// (Clerk's created_at, milliseconds), and when it was last seen: the
// latest of created_at, last_sign_in_at and last_active_at. Nothing else.
// createdAt is null if created_at is not a number. lastSeenAt is null if
// createdAt is, or if last_sign_in_at or last_active_at is anything but a
// number or null (missing or garbage: unknown, so never old enough); a
// null last_* just falls back to created_at.
export type ClerkUserRef = { id: string; createdAt: number | null; lastSeenAt: number | null };

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clerkUserRef(user: unknown): ClerkUserRef | null {
  const {
    id,
    created_at: rawCreated,
    last_sign_in_at: rawSignIn,
    last_active_at: rawActive,
  } = (user ?? {}) as { id?: unknown; created_at?: unknown; last_sign_in_at?: unknown; last_active_at?: unknown };
  if (typeof id !== "string" || !id) return null;
  const createdAt = timestamp(rawCreated);
  let lastSeenAt = createdAt;
  for (const raw of [rawSignIn, rawActive]) {
    if (raw === null || lastSeenAt === null) continue;
    const at = timestamp(raw);
    lastSeenAt = at === null ? null : Math.max(lastSeenAt, at);
  }
  return { id, createdAt, lastSeenAt };
}

// Every Clerk user, page by page (oldest first, so a user created while
// this runs only adds to the last page). Reads only `id`, `created_at`,
// `last_sign_in_at` and `last_active_at` from each user object
// (clerkUserRef). Throws with the HTTP status only (never the body, which
// could hold user data, nor the key).
export async function listClerkUsers(fetchFn: FetchLike, secretKey: string, pageSize = CLERK_PAGE_SIZE): Promise<ClerkUserRef[]> {
  const users: ClerkUserRef[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = `${CLERK_USERS_URL}?limit=${pageSize}&offset=${offset}&order_by=%2Bcreated_at`;
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${secretKey}` } });
    if (!response.ok) throw new ClerkListError(`Clerk users list failed: HTTP ${response.status}`);
    const body = await response.json();
    const page = Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? []);
    if (!Array.isArray(page)) throw new ClerkListError("Clerk users list: unexpected response shape");
    for (const user of page) {
      const ref = clerkUserRef(user);
      if (ref) users.push(ref);
    }
    if (page.length < pageSize) return users;
  }
}

// Every Clerk user id (listClerkUsers, ids only).
export async function listClerkUserIds(fetchFn: FetchLike, secretKey: string, pageSize = CLERK_PAGE_SIZE): Promise<string[]> {
  return (await listClerkUsers(fetchFn, secretKey, pageSize)).map((u) => u.id);
}
