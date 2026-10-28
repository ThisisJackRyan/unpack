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
// Before that, the Clerk instance id and environment type, the key type
// (sk_live or sk_test, from the prefix), and the database host and name
// (never the user, password, or key). Only id, created_at,
// last_sign_in_at and last_active_at are read from each Clerk user, and
// only id and environment_type from the instance; a failed Clerk call is
// reported by HTTP status only.

import { hashClerkUserId } from "@/lib/deleted-accounts";
import type { Statement } from "@/lib/link-rate-limit";
import type { RolelessDeleteOutcome } from "@/lib/under-13-account";
import { isLocalOrTestDatabase } from "./db-check";
import {
  CLERK_USERS_URL,
  ClerkListError,
  hashPrefix,
  listClerkUsers,
  type ClerkUserRef,
  type FetchLike,
} from "./pending-clerk-deletes";

// Long enough that nobody still in the middle of signing up is swept,
// short enough that a left-behind name and email don't linger. Also the
// floor: privacy.md promises 7 days, so --min-age-days can't go under it.
export const DEFAULT_MIN_AGE_DAYS = 7;
export const MIN_AGE_FLOOR_DAYS = 7;
// Clerk deletes per --apply run, so a mistake stays small.
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 500;

// The data-shape guards (sweepShapeRefusal). On the right database with
// the right Clerk instance, almost every aged Clerk user has a teachers
// row (a role-less account is the exception). Pointed at the wrong pair,
// almost none match, and every Clerk user would look role-less.
// - Any aged user and not one of them has a teachers row: abort.
// - At least NO_ROW_SHARE_MIN_AGED aged users and more than
//   NO_ROW_SHARE_MAX of them with no teachers row: abort. Below that many
//   the share is too noisy to mean anything (3 of 5 is normal early on).
export const NO_ROW_SHARE_MAX = 0.5;
export const NO_ROW_SHARE_MIN_AGED = 10;

export const SCRIPT = "pnpm ops:sweep-roleless-clerk-users";

export const USAGE =
  `Usage: ${SCRIPT} --expect-db=<host>/<dbname> --expect-instance=<ins_id> ` +
  "[--apply --expect-count=N] " +
  `[--min-age-days=N (default ${DEFAULT_MIN_AGE_DAYS}, at least ${MIN_AGE_FLOOR_DAYS})] ` +
  `[--limit=N (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})]`;

export type DatabaseRef = { host: string; name: string };

export type Options = {
  apply: boolean;
  minAgeDays: number;
  limit: number;
  // The database and Clerk instance the operator means (required), and,
  // with --apply, how many candidates the dry run showed.
  expectDb: DatabaseRef;
  expectInstance: string;
  expectCount: number | null;
};

function intValue(arg: string, prefix: string): number | null {
  const raw = arg.slice(prefix.length);
  return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
}

const INSTANCE_ID = /^ins_[A-Za-z0-9]{1,64}$/;

// Dry run unless --apply. --expect-db and --expect-instance are always
// required; --expect-count is required with --apply and refused without
// it. Anything unknown, repeated, or out of range is refused.
export function parseOptions(argv: readonly string[]): Options | { error: string } | { help: true } {
  let apply = false;
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  let limit = DEFAULT_LIMIT;
  let expectDb: DatabaseRef | null = null;
  let expectInstance: string | null = null;
  let expectCount: number | null = null;
  const seen = new Set<string>();
  for (const arg of argv) {
    const name = arg.split("=")[0];
    if (seen.has(name)) return { error: `${name} given twice. ${USAGE}` };
    seen.add(name);
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--min-age-days=")) {
      const days = intValue(arg, "--min-age-days=");
      if (days === null || days < MIN_AGE_FLOOR_DAYS) {
        return { error: `--min-age-days must be a whole number of days, at least ${MIN_AGE_FLOOR_DAYS}. ${USAGE}` };
      }
      minAgeDays = days;
    } else if (arg.startsWith("--limit=")) {
      const value = intValue(arg, "--limit=");
      if (value === null || value < 1 || value > MAX_LIMIT) return { error: `--limit must be from 1 to ${MAX_LIMIT}. ${USAGE}` };
      limit = value;
    } else if (arg.startsWith("--expect-db=")) {
      const match = /^([^/\s]+)\/([^/\s]+)$/.exec(arg.slice("--expect-db=".length));
      if (!match) return { error: `--expect-db must be <host>/<dbname>. ${USAGE}` };
      expectDb = { host: match[1].toLowerCase(), name: match[2] };
    } else if (arg.startsWith("--expect-instance=")) {
      const value = arg.slice("--expect-instance=".length);
      if (!INSTANCE_ID.test(value)) return { error: `--expect-instance must be a Clerk instance id (ins_...). ${USAGE}` };
      expectInstance = value;
    } else if (arg.startsWith("--expect-count=")) {
      expectCount = intValue(arg, "--expect-count=");
      if (expectCount === null) return { error: `--expect-count must be a whole number. ${USAGE}` };
    } else return { error: `Unknown argument. ${USAGE}` };
  }
  if (!expectDb) return { error: `--expect-db=<host>/<dbname> is required. ${USAGE}` };
  if (!expectInstance) return { error: `--expect-instance=<ins_id> is required. ${USAGE}` };
  if (apply && expectCount === null) return { error: `--apply needs --expect-count=N, the count the dry run showed. ${USAGE}` };
  if (!apply && expectCount !== null) return { error: `--expect-count only goes with --apply. ${USAGE}` };
  return { apply, minAgeDays, limit, expectDb, expectInstance, expectCount };
}

// The host and database name from DATABASE_URL, never the user or
// password. Null if it can't be read.
export function describeDatabaseUrl(url: string): DatabaseRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  return host && name ? { host, name } : null;
}

export type KeyType = "sk_live" | "sk_test";

// From the key's prefix only; the key itself is never printed.
export function clerkKeyType(secretKey: string): KeyType | null {
  if (secretKey.startsWith("sk_live_")) return "sk_live";
  if (secretKey.startsWith("sk_test_")) return "sk_test";
  return null;
}

export const CLERK_INSTANCE_URL = "https://api.clerk.com/v1/instance";

// development, staging or production, as Clerk reports it.
export type ClerkInstance = { id: string; environmentType: string };

// GET /v1/instance: the instance this key belongs to. Reads only `id` and
// `environment_type`; a failure throws with the HTTP status only.
export async function fetchClerkInstance(fetchFn: FetchLike, secretKey: string): Promise<ClerkInstance> {
  const response = await fetchFn(CLERK_INSTANCE_URL, { headers: { authorization: `Bearer ${secretKey}` } });
  if (!response.ok) throw new ClerkListError(`Clerk instance lookup failed: HTTP ${response.status}`);
  const { id, environment_type: environmentType } = ((await response.json()) ?? {}) as { id?: unknown; environment_type?: unknown };
  if (typeof id !== "string" || !INSTANCE_ID.test(id) || typeof environmentType !== "string" || !/^[a-z]{1,32}$/.test(environmentType)) {
    throw new ClerkListError("Clerk instance lookup: unexpected response shape");
  }
  return { id, environmentType };
}

export type Environment = {
  keyType: KeyType | null;
  instance: ClerkInstance;
  database: DatabaseRef | null;
  // isLocalOrTestDatabase (db-check.ts): localhost, *.localtest.me, or a
  // database name containing "test".
  testDatabase: boolean;
};

export function environmentLines(env: Environment): string[] {
  return [
    `Clerk: instance ${env.instance.id} (${env.instance.environmentType}), key type ${env.keyType ?? "unknown"}.`,
    env.database ? `Database: host ${env.database.host}, database ${env.database.name}.` : "Database: DATABASE_URL could not be read.",
  ];
}

// Why this run must not touch anything, or null. The pairing rule: a
// sk_test key belongs to a development instance and a local or test
// database; a sk_live key to a non-development instance and any other
// database. Then both sides must be the ones the operator named.
export function environmentRefusal(env: Environment, options: Pick<Options, "expectDb" | "expectInstance">): string | null {
  const { keyType, instance, database } = env;
  if (!keyType) return "CLERK_SECRET_KEY is neither a sk_live_ nor a sk_test_ key.";
  if (!database) return "DATABASE_URL has no readable host and database name.";
  const live = keyType === "sk_live";
  if (live === (instance.environmentType === "development")) {
    return `Live/test mismatch: a ${keyType} key, but Clerk says the instance is ${instance.environmentType}.`;
  }
  if (live === env.testDatabase) {
    return live
      ? "Live/test mismatch: a sk_live key with a local or test database."
      : "Live/test mismatch: a sk_test key with a database that is not local or test.";
  }
  if (database.host !== options.expectDb.host || database.name !== options.expectDb.name) {
    return `Database mismatch: --expect-db=${options.expectDb.host}/${options.expectDb.name}, but DATABASE_URL is ${database.host}/${database.name}.`;
  }
  if (instance.id !== options.expectInstance) {
    return `Clerk instance mismatch: --expect-instance=${options.expectInstance}, but the key belongs to ${instance.id}.`;
  }
  return null;
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

// Why the lookup looks like the wrong database for this Clerk instance,
// or null (see NO_ROW_SHARE_MAX above). `aged` are the users looked up.
export function sweepShapeRefusal(aged: readonly ClerkUserRef[], roleRows: readonly RoleRow[]): string | null {
  if (aged.length === 0) return null;
  const withRow = new Set(roleRows.map((r) => r.clerk_user_id));
  const noRow = aged.filter((u) => !withRow.has(u.id)).length;
  if (noRow === aged.length) {
    return `None of the ${aged.length} aged Clerk users has a teachers row: this looks like the wrong database for this Clerk instance.`;
  }
  if (aged.length >= NO_ROW_SHARE_MIN_AGED && noRow / aged.length > NO_ROW_SHARE_MAX) {
    return (
      `${noRow} of ${aged.length} aged Clerk users have no teachers row, over the ${NO_ROW_SHARE_MAX * 100}% limit: ` +
      "this looks like the wrong database for this Clerk instance."
    );
  }
  return null;
}

// The exact --apply command for what this dry run found (no environment
// values: the operator runs it with the same DATABASE_URL and
// CLERK_SECRET_KEY).
export function applyCommand(options: Options, count: number): string {
  return (
    `${SCRIPT} --apply --expect-db=${options.expectDb.host}/${options.expectDb.name} ` +
    `--expect-instance=${options.expectInstance} --min-age-days=${options.minAgeDays} --limit=${options.limit} --expect-count=${count}`
  );
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
  // Only its host and database name are ever printed (describeDatabaseUrl).
  databaseUrl: string;
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
  // Set when a guard refused the run before anything changed.
  aborted: "environment" | "shape" | "count" | null;
};

// DELETE /v1/users/{id}. A 404 means already gone in Clerk: done.
async function deleteInClerk(deps: SweepDeps, clerkUserId: string): Promise<{ ok: true } | { ok: false; status: number }> {
  const response = await deps.fetchFn(`${CLERK_USERS_URL}/${encodeURIComponent(clerkUserId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${deps.secretKey}` },
  });
  return response.ok || response.status === 404 ? { ok: true } : { ok: false, status: response.status };
}

// The whole run. First the guards, each one stopping the run before
// anything changes (result.aborted):
// - environment: prints the Clerk instance (GET /v1/instance), key type,
//   and database host and name, then refuses a live/test mismatch or an
//   --expect-db / --expect-instance that isn't this pair
//   (environmentRefusal). Nothing is listed or looked up.
// - shape: after the lookup, refuses a lookup that looks like the wrong
//   database (sweepShapeRefusal).
// - count: with --apply, refuses unless --expect-count is exactly the
//   number of candidates found by this run.
// Dry run: lists the candidates and the exact --apply command, writes
// nothing, and never sends a DELETE. Apply: for each candidate, oldest
// first, until `limit` Clerk deletes are done:
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
  const result: SweepResult = { checked: 0, candidates: 0, deleted: 0, skippedHasRole: 0, stoppedStatus: null, aborted: null };
  const abort = (reason: NonNullable<SweepResult["aborted"]>, message: string): SweepResult => {
    print(`Refused: ${message} Nothing changed.`);
    result.aborted = reason;
    return result;
  };

  const env: Environment = {
    keyType: clerkKeyType(deps.secretKey),
    instance: await fetchClerkInstance(deps.fetchFn, deps.secretKey),
    database: describeDatabaseUrl(deps.databaseUrl),
    testDatabase: isLocalOrTestDatabase(deps.databaseUrl),
  };
  for (const line of environmentLines(env)) print(line);
  const refusal = environmentRefusal(env, options);
  if (refusal) return abort("environment", refusal);

  const users = await listClerkUsers(deps.fetchFn, deps.secretKey, deps.pageSize);
  const aged = olderThan(users, options.minAgeDays, now);
  result.checked = users.length;
  print(`Checked ${plural(users.length, "Clerk user", "Clerk users")}, ${aged.length} created and last seen at least ${plural(options.minAgeDays, "day", "days")} ago.`);
  const { roleRows, listed } = aged.length > 0 ? await deps.lookup(aged.map((u) => u.id)) : { roleRows: [], listed: [] };
  const shape = sweepShapeRefusal(aged, roleRows);
  if (shape) return abort("shape", shape);

  const candidates = pickCandidates(aged, roleRows, listed);
  result.candidates = candidates.length;
  print(`${plural(candidates.length, "role-less account", "role-less accounts")} (no teacher or self-learner role):`);
  for (const candidate of candidates) print(candidateLine(candidate, now));

  if (!options.apply) {
    if (candidates.length === 0) {
      print("Dry run: nothing deleted, and nothing to apply.");
      return result;
    }
    const would = Math.min(candidates.length, options.limit);
    print(`Dry run: nothing deleted. --apply would delete up to ${would} of these, oldest first (--limit=${options.limit}).`);
    print("To apply, check the list above, then run with the same DATABASE_URL and CLERK_SECRET_KEY:");
    print(`  ${applyCommand(options, candidates.length)}`);
    return result;
  }

  if (options.expectCount !== candidates.length) {
    return abort(
      "count",
      `--expect-count=${options.expectCount}, but this run found ${candidates.length}. Run the dry run again and check the list.`,
    );
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
