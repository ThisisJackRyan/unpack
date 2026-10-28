// Checks the role-less Clerk sweep (pnpm ops:sweep-roleless-clerk-users)
// through the real neon-http driver and the real statements, with a FAKE
// Clerk (no Clerk calls; the fetch is injected and nothing else is):
//
// (a) Dry run: of a teacher, a self-learner, a row with no role, an id
//     with no row, a pending and a confirmed delete (all old), a young id
//     with no row, and an old no-role row active a day ago (back on
//     /welcome), the candidates are exactly the no-role row, the no-row
//     id, and the pending one. No DELETE is sent and nothing in the
//     database changes.
// (b) Apply with a race: the no-role row saves a role right after the
//     lookup. The re-check skips it (row and role kept, nothing listed);
//     the other two are deleted in Clerk and their hashes confirmed; the
//     role holders, the young id and the active one are untouched.
// (c) Apply: a row with no role is deleted, its hash confirmed; then a
//     late user.created is refused (deleted_account) and the webhook's
//     user.deleted is already_gone.
// (d) Apply on an aged self-learner (age_confirmed_at set, as the check
//     constraint needs) and a no-role row that becomes a self-learner
//     right after the lookup: both rows, roles and age_confirmed_at are
//     kept, nothing is listed, and no Clerk DELETE is sent for either.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-roleless-clerk-sweep
//
// Same database guard, connection cap, and NEON_FETCH_ENDPOINT handling as
// every check (scripts/lib/db-check.ts). Writes accounts and listed hashes
// for ids named test_sweep_*_<run> and deletes them at the end. Never run
// against production.
import { getSql } from "@/db";
import { handleClerkEvent } from "@/lib/clerk-webhook";
import { hashClerkUserId } from "@/lib/deleted-accounts";
import { neonExecutor } from "@/lib/neon-executor";
import { prepareDbCheck } from "./lib/db-check";
import type { FetchLike } from "./lib/pending-clerk-deletes";
import { DEFAULT_LIMIT, DEFAULT_MIN_AGE_DAYS, runSweep, type Options, type SweepDeps } from "./lib/roleless-clerk-sweep";
import { sweepDbDeps } from "./lib/roleless-clerk-sweep-db";

const { fetchEndpoint } = prepareDbCheck();

const RUN_ID = Math.random().toString(36).slice(2, 10);
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

const used = new Set<string>();
function id(label: string): string {
  const value = `test_sweep_${label}_${RUN_ID}`;
  used.add(value);
  return value;
}

// A fake Clerk listing the given users (id, created_at, last_sign_in_at
// and last_active_at only; the last two null unless activeDays is given),
// and recording each DELETE.
function fakeClerk(users: { id: string; ageDays: number; activeDays?: number }[]) {
  const deletes: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    if (init.method === "DELETE") {
      deletes.push(decodeURIComponent(url.split("/").pop() ?? ""));
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    const offset = Number(new URL(url).searchParams.get("offset"));
    const page =
      offset === 0
        ? users.map((u) => {
            const active = u.activeDays === undefined ? null : NOW.getTime() - u.activeDays * DAY;
            return { id: u.id, created_at: NOW.getTime() - u.ageDays * DAY, last_sign_in_at: active, last_active_at: active };
          })
        : [];
    return { ok: true, status: 200, json: async () => page };
  };
  return { fetchFn, deletes };
}

function deps(fetchFn: FetchLike, lines: string[]): SweepDeps {
  return { fetchFn, secretKey: "sk_test_fake", ...sweepDbDeps(), print: (line) => lines.push(line), now: NOW };
}

const DRY: Options = { apply: false, minAgeDays: DEFAULT_MIN_AGE_DAYS, limit: DEFAULT_LIMIT };

async function insertAccount(clerkUserId: string, role: "teacher" | "self_learner" | null): Promise<void> {
  await sql.query(
    `insert into teachers (clerk_user_id, email, role, age_confirmed_at)
values ($1::text, 'test@example.invalid', $2::account_role, case when $2::text = 'self_learner' then now() end)`,
    [clerkUserId, role],
  );
}

async function listState(clerkUserId: string): Promise<"none" | "pending" | "confirmed"> {
  const rows = await sql.query(`select clerk_deleted_at from deleted_clerk_users where clerk_user_hash = $1::text`, [hashClerkUserId(clerkUserId)]);
  if (rows.length === 0) return "none";
  return rows[0].clerk_deleted_at === null ? "pending" : "confirmed";
}

async function roleOf(clerkUserId: string): Promise<string | null | undefined> {
  const rows = await sql.query(`select role from teachers where clerk_user_id = $1::text`, [clerkUserId]);
  return rows.length === 0 ? undefined : (rows[0].role as string | null);
}

async function checkDryRunAndRace(): Promise<void> {
  const teacher = id("teacher");
  const self = id("self");
  const noRole = id("norole");
  const noRow = id("norow");
  const pending = id("pending");
  const confirmed = id("confirmed");
  const young = id("young");
  const back = id("back");
  await insertAccount(teacher, "teacher");
  await insertAccount(self, "self_learner");
  await insertAccount(noRole, null);
  await insertAccount(back, null);
  await sql.query(`insert into deleted_clerk_users (clerk_user_hash) values ($1::text)`, [hashClerkUserId(pending)]);
  await sql.query(`insert into deleted_clerk_users (clerk_user_hash, clerk_deleted_at) values ($1::text, now())`, [hashClerkUserId(confirmed)]);
  const users = [
    { id: teacher, ageDays: 30 },
    { id: self, ageDays: 30 },
    { id: noRole, ageDays: 20 },
    { id: noRow, ageDays: 15 },
    { id: pending, ageDays: 10 },
    { id: confirmed, ageDays: 10 },
    { id: young, ageDays: 2 },
    { id: back, ageDays: 60, activeDays: 1 },
  ];

  console.log("\n(a) dry run");
  const dry = fakeClerk(users);
  const lines: string[] = [];
  const result = await runSweep(DRY, deps(dry.fetchFn, lines));
  const listedIds = lines.filter((l) => l.startsWith("  test_sweep_")).map((l) => l.trim().split(/\s+/)[0]);
  check(result.candidates === 3 && listedIds.join(",") === [noRole, noRow, pending].join(","), `3 candidates: no role, no row, pending (got ${result.candidates})`);
  check(dry.deletes.length === 0, "no DELETE sent");
  check((await roleOf(noRole)) === null && (await listState(noRow)) === "none" && (await listState(pending)) === "pending", "database unchanged");

  console.log("\n(b) apply, the no-role row saves a role right after the lookup");
  const apply = fakeClerk(users);
  const raceDeps = deps(apply.fetchFn, []);
  const lookup = raceDeps.lookup;
  raceDeps.lookup = async (ids) => {
    const found = await lookup(ids);
    await sql.query(`update teachers set role = 'teacher' where clerk_user_id = $1::text`, [noRole]);
    return found;
  };
  const applied = await runSweep({ ...DRY, apply: true }, raceDeps);
  check(applied.skippedHasRole === 1 && applied.deleted === 2, `1 skipped, 2 deleted (got ${applied.skippedHasRole}, ${applied.deleted})`);
  check(apply.deletes.join(",") === [noRow, pending].join(","), "Clerk DELETE only for the no-row and pending ids");
  check((await roleOf(noRole)) === "teacher" && (await listState(noRole)) === "none", "the raced account keeps its row and role, nothing listed");
  check((await listState(noRow)) === "confirmed" && (await listState(pending)) === "confirmed", "deleted hashes confirmed");
  check((await roleOf(teacher)) === "teacher" && (await roleOf(self)) === "self_learner", "role holders untouched");
  check((await listState(young)) === "none" && (await listState(teacher)) === "none" && (await listState(self)) === "none", "young id and role holders not listed");
  check((await roleOf(back)) === null && (await listState(back)) === "none", "the recently active no-role row is kept, nothing listed");
}

async function checkDeleteThenLateEvents(): Promise<void> {
  console.log("\n(c) apply on a no-role row, then late webhook events");
  const noRole = id("late");
  await insertAccount(noRole, null);
  const clerk = fakeClerk([{ id: noRole, ageDays: 8 }]);
  const result = await runSweep({ ...DRY, apply: true }, deps(clerk.fetchFn, []));
  check(result.deleted === 1 && clerk.deletes.join() === noRole, "deleted in Clerk");
  check((await roleOf(noRole)) === undefined && (await listState(noRole)) === "confirmed", "row gone, hash confirmed");
  const created = await handleClerkEvent(
    { type: "user.created", data: { id: noRole, email_addresses: [{ id: "e1", email_address: "late@example.invalid" }], primary_email_address_id: "e1" } },
    neonExecutor,
  );
  check(created === "deleted_account" && (await roleOf(noRole)) === undefined, `late user.created refused (${created})`);
  const deleted = await handleClerkEvent({ type: "user.deleted", data: { id: noRole } }, neonExecutor);
  check(deleted === "already_gone", `user.deleted is already_gone (${deleted})`);
}

async function ageConfirmed(clerkUserId: string): Promise<boolean> {
  const rows = await sql.query(`select age_confirmed_at is not null as confirmed from teachers where clerk_user_id = $1::text`, [clerkUserId]);
  return rows[0]?.confirmed === true;
}

async function checkSelfLearnerNeverSwept(): Promise<void> {
  console.log("\n(d) apply on an aged self-learner, and a no-role row that becomes one after the lookup");
  const self = id("oldself");
  const becomes = id("becomes");
  await insertAccount(self, "self_learner");
  await insertAccount(becomes, null);
  const clerk = fakeClerk([
    { id: self, ageDays: 400 },
    { id: becomes, ageDays: 20 },
  ]);
  const raceDeps = deps(clerk.fetchFn, []);
  const lookup = raceDeps.lookup;
  raceDeps.lookup = async (ids) => {
    const found = await lookup(ids);
    await sql.query(`update teachers set role = 'self_learner', age_confirmed_at = now() where clerk_user_id = $1::text`, [becomes]);
    return found;
  };
  const result = await runSweep({ ...DRY, apply: true }, raceDeps);
  check(result.candidates === 1 && result.skippedHasRole === 1 && result.deleted === 0, `only the no-role row was a candidate, then skipped (got ${result.candidates}, ${result.skippedHasRole}, ${result.deleted})`);
  check(!clerk.deletes.includes(self) && !clerk.deletes.includes(becomes), "no Clerk DELETE for either self-learner");
  check((await roleOf(self)) === "self_learner" && (await ageConfirmed(self)), "the aged self-learner keeps its row, role and age_confirmed_at");
  check((await roleOf(becomes)) === "self_learner" && (await ageConfirmed(becomes)), "the raced self-learner keeps its row, role and age_confirmed_at");
  check((await listState(self)) === "none" && (await listState(becomes)) === "none", "neither self-learner is listed");
}

async function cleanup(): Promise<void> {
  const ids = [...used];
  const rows = await sql.query(`delete from teachers where clerk_user_id = any($1::text[]) returning id`, [ids]);
  const hashes = await sql.query(`delete from deleted_clerk_users where clerk_user_hash = any($1::text[]) returning clerk_user_hash`, [ids.map(hashClerkUserId)]);
  console.log(`\ncleanup: deleted ${rows.length} test accounts, ${hashes.length} listed hashes`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}`);
  try {
    await checkDryRunAndRace();
    await checkDeleteThenLateEvents();
    await checkSelfLearnerNeverSwept();
  } finally {
    await cleanup();
  }
  if (failures.length) {
    console.log(`\nFAIL\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((error) => {
  console.error("check-roleless-clerk-sweep crashed:", error);
  process.exit(1);
});
