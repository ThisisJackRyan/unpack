// The pure parts of scripts/sweep-roleless-clerk-users.ts: argument
// parsing, picking the candidates, the report lines, and the sweep itself
// over injected dependencies (Clerk fetch, database lookups, the local
// delete, output). Tests run it with fakes (roleless-clerk-sweep.test.ts);
// nothing here reaches Clerk or a database on its own.
//
// Role-less: a Clerk account whose id has no teachers row with a role
// (teacher or self_learner). Students are not Clerk users (they join with
// a class code; student-auth.ts), and every Clerk account's app row is the
// teachers row (account.ts, clerk-webhook.ts), so that one table decides.
// Two kinds: no row at all (never visited, and user.created never landed
// or was refused), or a row whose role is still null (stopped at
// /welcome; the row holds the name and email). An id whose hash is
// confirmed on deleted_clerk_users is skipped (Clerk already confirmed
// its delete); a pending one is a candidate (this finishes that delete).
//
// Nothing personal is ever printed: per candidate, the Clerk id (what ops
// already prints, list-pending-clerk-deletes.ts), a 12-character prefix of
// its hash, which kind it is, and how many days ago it was last seen.
// Only id, created_at, last_sign_in_at and last_active_at are read from
// Clerk; a failed Clerk call is reported by HTTP status only.

import { hashClerkUserId } from "@/lib/deleted-accounts";
import type { Statement } from "@/lib/link-rate-limit";
import type { RolelessDeleteOutcome } from "@/lib/under-13-account";
import { CLERK_USERS_URL, hashPrefix, listClerkUsers, type ClerkUserRef, type FetchLike } from "./pending-clerk-deletes";

// Long enough that nobody still in the middle of signing up is swept,
// short enough that a left-behind name and email don't linger.
export const DEFAULT_MIN_AGE_DAYS = 7;
// The hard floor for --min-age-days: never sweep an account under a day old.
export const MIN_AGE_FLOOR_DAYS = 1;
// Clerk deletes per --apply run, so a mistake stays small.
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 500;

export const USAGE =
  "Usage: pnpm ops:sweep-roleless-clerk-users [--apply] " +
  `[--min-age-days=N (default ${DEFAULT_MIN_AGE_DAYS}, at least ${MIN_AGE_FLOOR_DAYS})] ` +
  `[--limit=N (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})]`;

export type Options = { apply: boolean; minAgeDays: number; limit: number };

function intValue(arg: string, prefix: string): number | null {
  const raw = arg.slice(prefix.length);
  return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
}

// Dry run unless --apply. Anything unknown, repeated, or out of range is
// refused.
export function parseOptions(argv: readonly string[]): Options | { error: string } | { help: true } {
  const options: Options = { apply: false, minAgeDays: DEFAULT_MIN_AGE_DAYS, limit: DEFAULT_LIMIT };
  const seen = new Set<string>();
  for (const arg of argv) {
    const name = arg.split("=")[0];
    if (seen.has(name)) return { error: `${name} given twice. ${USAGE}` };
    seen.add(name);
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--min-age-days=")) {
      const days = intValue(arg, "--min-age-days=");
      if (days === null || days < MIN_AGE_FLOOR_DAYS) {
        return { error: `--min-age-days must be a whole number of days, at least ${MIN_AGE_FLOOR_DAYS}. ${USAGE}` };
      }
      options.minAgeDays = days;
    } else if (arg.startsWith("--limit=")) {
      const limit = intValue(arg, "--limit=");
      if (limit === null || limit < 1 || limit > MAX_LIMIT) return { error: `--limit must be from 1 to ${MAX_LIMIT}. ${USAGE}` };
      options.limit = limit;
    } else return { error: `Unknown argument. ${USAGE}` };
  }
  return options;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Created AND last seen (latest of created_at, last_sign_in_at,
// last_active_at) at least minAgeDays ago, so an old account that came
// back and is on /welcome right now is not swept. An unknown time (null:
// missing or garbage, see clerkUserRef) is never old enough.
export function olderThan(users: readonly ClerkUserRef[], minAgeDays: number, now: Date): ClerkUserRef[] {
  const cutoff = now.getTime() - minAgeDays * DAY_MS;
  return users.filter((u) => u.createdAt !== null && u.lastSeenAt !== null && u.createdAt <= cutoff && u.lastSeenAt <= cutoff);
}

// The database side for a set of Clerk ids, read in one read-only
// transaction: their teachers rows (id and role only, never the name or
// email), and their deleted_clerk_users rows (hash and whether confirmed).
export function sweepLookupStatements(clerkUserIds: readonly string[]): Statement[] {
  return [
    {
      text: `select clerk_user_id, role from teachers where clerk_user_id = any($1::text[])`,
      params: [[...clerkUserIds]],
    },
    {
      text: `select clerk_user_hash, clerk_deleted_at is not null as confirmed from deleted_clerk_users
where clerk_user_hash = any($1::text[])`,
      params: [clerkUserIds.map(hashClerkUserId)],
    },
  ];
}

export type RoleRow = { clerk_user_id: string; role: string | null };
export type ListedRow = { clerk_user_hash: string; confirmed: boolean };

// no_row: no teachers row. no_role: a row with role null. pending: no row,
// and the hash is listed with Clerk's delete pending.
export type CandidateKind = "no_row" | "no_role" | "pending";

export type Candidate = { id: string; hash: string; kind: CandidateKind; lastSeenAt: number };

// The role-less accounts among `users` (already filtered by age), oldest
// created first as Clerk listed them.
export function pickCandidates(users: readonly ClerkUserRef[], roleRows: readonly RoleRow[], listed: readonly ListedRow[]): Candidate[] {
  const roles = new Map(roleRows.map((r) => [r.clerk_user_id, r.role]));
  const listedState = new Map(listed.map((r) => [r.clerk_user_hash, r.confirmed]));
  const candidates: Candidate[] = [];
  for (const user of users) {
    if (user.lastSeenAt === null) continue;
    const role = roles.get(user.id);
    if (role !== undefined && role !== null) continue;
    const hash = hashClerkUserId(user.id);
    const confirmed = listedState.get(hash);
    if (confirmed === true) continue;
    const kind: CandidateKind = role === null ? "no_role" : confirmed === false ? "pending" : "no_row";
    candidates.push({ id: user.id, hash, kind, lastSeenAt: user.lastSeenAt });
  }
  return candidates;
}

const KIND_LABEL: Record<CandidateKind, string> = {
  no_row: "no app row",
  no_role: "row with no role",
  pending: "delete pending",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function candidateLine(candidate: Candidate, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - candidate.lastSeenAt) / DAY_MS));
  return `  ${candidate.id}  (${hashPrefix(candidate.hash)})  ${KIND_LABEL[candidate.kind]}, last seen ${plural(days, "day", "days")} ago`;
}

export type SweepDeps = {
  fetchFn: FetchLike;
  secretKey: string;
  // Runs sweepLookupStatements in a read-only transaction.
  lookup: (clerkUserIds: readonly string[]) => Promise<{ roleRows: RoleRow[]; listed: ListedRow[] }>;
  // Runs deleteRolelessAccountStatements (under-13-account.ts) as one
  // transaction: the re-check and the local delete together.
  deleteLocal: (clerkUserId: string) => Promise<RolelessDeleteOutcome>;
  // Runs confirmClerkDeletedStatement: Clerk's delete is done.
  confirmClerkDeleted: (clerkUserId: string) => Promise<void>;
  print: (line: string) => void;
  now: Date;
  // Clerk users per list page (tests use a small one).
  pageSize?: number;
};

export type SweepResult = {
  checked: number;
  candidates: number;
  deleted: number;
  skippedHasRole: number;
  // The HTTP status of the Clerk delete that stopped the run.
  stoppedStatus: number | null;
};

// DELETE /v1/users/{id}. A 404 means already gone in Clerk: done.
async function deleteInClerk(deps: SweepDeps, clerkUserId: string): Promise<{ ok: true } | { ok: false; status: number }> {
  const response = await deps.fetchFn(`${CLERK_USERS_URL}/${encodeURIComponent(clerkUserId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${deps.secretKey}` },
  });
  return response.ok || response.status === 404 ? { ok: true } : { ok: false, status: response.status };
}

// The whole run. Dry run: lists the candidates, writes nothing, and never
// sends a DELETE. Apply: for each candidate, oldest first, until `limit`
// Clerk deletes are done:
// 1. deleteLocal re-checks and deletes in one transaction, behind the
//    id's account lock: an account that got a role since the lookup is
//    skipped (has_role, nothing changed); otherwise the role-less row (if
//    any) is deleted and the hash listed as pending, so from that moment a
//    first visit or a late user.created can't make a new row, and a role
//    can't be saved (there is no row to save it on). This closes the race
//    with someone finishing sign-up right now.
// 2. Clerk's DELETE /v1/users/{id}. A failure stops the run with only the
//    status printed; the hash stays pending, so the sign-in retry and
//    pnpm ops:list-pending-clerk-deletes pick it up.
// 3. confirmClerkDeleted, so the list prunes the hash after its 30 days.
//    Clerk then sends user.deleted, and the webhook finds no row
//    (already_gone) and confirms again, a no-op.
// A database error is thrown as is (the caller prints its name and code).
export async function runSweep(options: Options, deps: SweepDeps): Promise<SweepResult> {
  const { print, now } = deps;
  const users = await listClerkUsers(deps.fetchFn, deps.secretKey, deps.pageSize);
  const aged = olderThan(users, options.minAgeDays, now);
  const { roleRows, listed } = aged.length > 0 ? await deps.lookup(aged.map((u) => u.id)) : { roleRows: [], listed: [] };
  const candidates = pickCandidates(aged, roleRows, listed);
  const result: SweepResult = { checked: users.length, candidates: candidates.length, deleted: 0, skippedHasRole: 0, stoppedStatus: null };

  print(`Checked ${plural(users.length, "Clerk user", "Clerk users")}, ${aged.length} created and last seen at least ${plural(options.minAgeDays, "day", "days")} ago.`);
  print(`${plural(candidates.length, "role-less account", "role-less accounts")} (no teacher or self-learner role):`);
  for (const candidate of candidates) print(candidateLine(candidate, now));

  if (!options.apply) {
    const would = Math.min(candidates.length, options.limit);
    print(`Dry run: nothing deleted. --apply would delete up to ${would} of these, oldest first (--limit=${options.limit}).`);
    return result;
  }

  for (const candidate of candidates) {
    if (result.deleted >= options.limit) break;
    const local = await deps.deleteLocal(candidate.id);
    if (local === "has_role") {
      result.skippedHasRole++;
      print(`  skipped ${candidate.id}  (${hashPrefix(candidate.hash)}): has a role now, nothing changed`);
      continue;
    }
    const clerk = await deleteInClerk(deps, candidate.id);
    if (!clerk.ok) {
      result.stoppedStatus = clerk.status;
      print(`  Clerk delete failed: HTTP ${clerk.status}. Stopped. (${hashPrefix(candidate.hash)}) stays pending (pnpm ops:list-pending-clerk-deletes).`);
      break;
    }
    await deps.confirmClerkDeleted(candidate.id);
    result.deleted++;
    print(`  deleted ${candidate.id}  (${hashPrefix(candidate.hash)})`);
  }
  print(
    `Deleted ${plural(result.deleted, "account", "accounts")}; ${result.skippedHasRole} skipped (got a role); ` +
      `${candidates.length - result.deleted - result.skippedHasRole} left for a later run.`,
  );
  return result;
}
