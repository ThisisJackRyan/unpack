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
// (e) Environment mismatch: a wrong --expect-db, a wrong
//     --expect-instance, a sk_live key against this test database, and a
//     sk_test key whose instance says production are each refused before
//     any Clerk user is listed or any row looked up; no DELETE, nothing
//     changes.
// (f) Zero match: aged Clerk ids, none with a teachers row (as when the
//     database is the wrong one), aborts --apply with nothing changed.
// (g) High share: 10 aged ids, 6 with no teachers row (over 50%), aborts
//     --apply with nothing changed.
// (h) Normal run: 10 aged ids, 5 with no row (exactly 50%), proceeds: a
//     wrong --expect-count, a missing --expect-ids, and an --expect-ids
//     for other accounts (same count) are each refused with nothing
//     changed, then the --apply command the dry run printed (its count and
//     id digest) deletes the 5 and keeps the teachers.
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
import {
  candidatesDigest,
  DEFAULT_LIMIT,
  DEFAULT_MIN_AGE_DAYS,
  describeDatabaseUrl,
  parseOptions,
  runSweep,
  type Candidate,
  type Options,
  type SweepDeps,
} from "./lib/roleless-clerk-sweep";
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

const FAKE_INSTANCE = "ins_fakecheck";

// A fake Clerk: GET /v1/instance answers FAKE_INSTANCE (development unless
// `environmentType` says otherwise); GET /v1/users lists the given users
// (id, created_at, last_sign_in_at and last_active_at only; the last two
// null unless activeDays is given). Records each list and DELETE.
function fakeClerk(users: { id: string; ageDays: number; activeDays?: number }[], environmentType = "development") {
  const deletes: string[] = [];
  let lists = 0;
  const fetchFn: FetchLike = async (url, init) => {
    if (url === "https://api.clerk.com/v1/instance") {
      return { ok: true, status: 200, json: async () => ({ id: FAKE_INSTANCE, environment_type: environmentType }) };
    }
    if (init.method === "DELETE") {
      deletes.push(decodeURIComponent(url.split("/").pop() ?? ""));
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    lists++;
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
  return { fetchFn, deletes, lists: () => lists };
}

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function deps(fetchFn: FetchLike, lines: string[]): SweepDeps {
  return { fetchFn, secretKey: "sk_test_fake", databaseUrl: DATABASE_URL, ...sweepDbDeps(), print: (line) => lines.push(line), now: NOW };
}

// prepareDbCheck already refused anything but a readable local or test URL.
const THIS_DB = describeDatabaseUrl(DATABASE_URL) ?? { host: "", name: "" };
const DRY: Options = {
  apply: false,
  minAgeDays: DEFAULT_MIN_AGE_DAYS,
  limit: DEFAULT_LIMIT,
  expectDb: THIS_DB,
  expectInstance: FAKE_INSTANCE,
  expectCount: null,
  expectIds: null,
};
const digestOf = (ids: readonly string[]) => candidatesDigest(ids.map((id) => ({ id })) as Candidate[]);
// --apply with --expect-count and --expect-ids for exactly these
// candidate ids, as the dry run would print them.
const applyIds = (ids: readonly string[]): Options => ({ ...DRY, apply: true, expectCount: ids.length, expectIds: digestOf(ids) });

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
  const applied = await runSweep(applyIds([noRole, noRow, pending]), raceDeps);
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
  const result = await runSweep(applyIds([noRole]), deps(clerk.fetchFn, []));
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
  const result = await runSweep(applyIds([becomes]), raceDeps);
  check(result.candidates === 1 && result.skippedHasRole === 1 && result.deleted === 0, `only the no-role row was a candidate, then skipped (got ${result.candidates}, ${result.skippedHasRole}, ${result.deleted})`);
  check(!clerk.deletes.includes(self) && !clerk.deletes.includes(becomes), "no Clerk DELETE for either self-learner");
  check((await roleOf(self)) === "self_learner" && (await ageConfirmed(self)), "the aged self-learner keeps its row, role and age_confirmed_at");
  check((await roleOf(becomes)) === "self_learner" && (await ageConfirmed(becomes)), "the raced self-learner keeps its row, role and age_confirmed_at");
  check((await listState(self)) === "none" && (await listState(becomes)) === "none", "neither self-learner is listed");
}

// The state the guards must leave alone: each id's role (undefined: no
// row) and listed state.
async function snapshot(ids: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const clerkUserId of ids) parts.push(`${String(await roleOf(clerkUserId))}:${await listState(clerkUserId)}`);
  return parts.join(",");
}

// Runs one sweep, counting the lookups it makes.
async function runCounted(options: Options, sweepDeps: SweepDeps): Promise<{ result: Awaited<ReturnType<typeof runSweep>>; lookups: number }> {
  let lookups = 0;
  const lookup = sweepDeps.lookup;
  sweepDeps.lookup = async (ids) => {
    lookups++;
    return lookup(ids);
  };
  return { result: await runSweep(options, sweepDeps), lookups };
}

async function checkEnvironmentMismatch(): Promise<void> {
  console.log("\n(e) environment mismatch is refused before any listing or lookup");
  const teacher = id("envteacher");
  const noRole = id("envnorole");
  const noRow = id("envnorow");
  await insertAccount(teacher, "teacher");
  await insertAccount(noRole, null);
  const users = [
    { id: teacher, ageDays: 30 },
    { id: noRole, ageDays: 30 },
    { id: noRow, ageDays: 30 },
  ];
  const before = await snapshot([teacher, noRole, noRow]);
  const cases: { name: string; options: Options; secretKey?: string; environmentType?: string }[] = [
    { name: "wrong --expect-db", options: { ...applyIds(["test_sweep_a", "test_sweep_b"]), expectDb: { host: THIS_DB.host, name: `${THIS_DB.name}_other` } } },
    { name: "wrong --expect-instance", options: { ...applyIds(["test_sweep_a", "test_sweep_b"]), expectInstance: "ins_someotherinstance" } },
    { name: "sk_live key with this test database", options: applyIds(["test_sweep_a", "test_sweep_b"]), secretKey: "sk_live_fake", environmentType: "production" },
    { name: "sk_test key, Clerk says production", options: applyIds(["test_sweep_a", "test_sweep_b"]), environmentType: "production" },
  ];
  for (const c of cases) {
    const clerk = fakeClerk(users, c.environmentType);
    const lines: string[] = [];
    const sweepDeps = { ...deps(clerk.fetchFn, lines), ...(c.secretKey ? { secretKey: c.secretKey } : {}) };
    const { result, lookups } = await runCounted(c.options, sweepDeps);
    check(
      result.aborted === "environment" && clerk.lists() === 0 && lookups === 0 && clerk.deletes.length === 0,
      `${c.name}: refused, no listing, no lookup, no DELETE (${lines.at(-1) ?? ""})`,
    );
    check(lines[1] === `Database: host ${THIS_DB.host}, database ${THIS_DB.name}.` && lines[0].startsWith(`Clerk: instance ${FAKE_INSTANCE} `), `${c.name}: printed the pair first`);
  }
  check((await snapshot([teacher, noRole, noRow])) === before, "database unchanged");
}

async function checkZeroMatch(): Promise<void> {
  console.log("\n(f) zero match: aged ids, none with a teachers row");
  const ids = [id("zero1"), id("zero2"), id("zero3")];
  const clerk = fakeClerk(ids.map((clerkUserId) => ({ id: clerkUserId, ageDays: 30 })));
  const lines: string[] = [];
  const result = await runSweep({ ...applyIds([]), expectCount: 3 }, deps(clerk.fetchFn, lines));
  check(result.aborted === "shape" && result.candidates === 0, `aborted (${lines.at(-1) ?? ""})`);
  check(clerk.deletes.length === 0, "no DELETE sent");
  check((await snapshot(ids)) === ids.map(() => "undefined:none").join(","), "nothing listed, no row made");
}

async function checkHighShare(): Promise<void> {
  console.log("\n(g) high share: 6 of 10 aged ids with no teachers row");
  const withRow = [id("share_t1"), id("share_t2"), id("share_t3"), id("share_n1")];
  const noRow = [1, 2, 3, 4, 5, 6].map((n) => id(`share_x${n}`));
  for (const clerkUserId of withRow) await insertAccount(clerkUserId, clerkUserId.includes("share_n") ? null : "teacher");
  const all = [...withRow, ...noRow];
  const before = await snapshot(all);
  const clerk = fakeClerk(all.map((clerkUserId) => ({ id: clerkUserId, ageDays: 30 })));
  const lines: string[] = [];
  const result = await runSweep({ ...applyIds([]), expectCount: 7 }, deps(clerk.fetchFn, lines));
  check(result.aborted === "shape", `aborted (${lines.at(-1) ?? ""})`);
  check(clerk.deletes.length === 0, "no DELETE sent");
  check((await snapshot(all)) === before, "database unchanged");
}

async function checkNormalRun(): Promise<void> {
  console.log("\n(h) normal run: 5 of 10 aged ids with no teachers row");
  const teachers = [1, 2, 3, 4, 5].map((n) => id(`normal_t${n}`));
  const noRow = [1, 2, 3, 4, 5].map((n) => id(`normal_x${n}`));
  for (const clerkUserId of teachers) await insertAccount(clerkUserId, "teacher");
  const all = [...teachers, ...noRow];
  const users = all.map((clerkUserId) => ({ id: clerkUserId, ageDays: 30 }));

  const dryLines: string[] = [];
  const dry = await runSweep(DRY, deps(fakeClerk(users).fetchFn, dryLines));
  check(dry.aborted === null && dry.candidates === 5, `dry run proceeds with 5 candidates (got ${dry.candidates})`);
  const command = (dryLines.at(-1) ?? "").trim();
  check(command.endsWith(`--expect-count=5 --expect-ids=${digestOf(noRow)}`), "dry run prints the --apply command with --expect-count=5 and the id digest");

  const before = await snapshot(all);
  const wrong = fakeClerk(users);
  const refused = await runSweep({ ...applyIds(noRow), expectCount: 4 }, deps(wrong.fetchFn, []));
  check(refused.aborted === "count" && wrong.deletes.length === 0, "a wrong --expect-count is refused, no DELETE");
  check((await snapshot(all)) === before, "database unchanged after the refused count");

  const withoutIds = parseOptions(command.split(" ").slice(2).filter((arg) => !arg.startsWith("--expect-ids=")));
  check("error" in withoutIds && withoutIds.error.startsWith("--apply needs --expect-ids"), "--apply without --expect-ids is refused before anything runs");

  // Same count, one id different: a digest over other accounts.
  const otherIds = fakeClerk(users);
  const otherLines: string[] = [];
  const mismatch = await runSweep({ ...applyIds([...noRow.slice(1), id("normal_other")]) }, deps(otherIds.fetchFn, otherLines));
  check(mismatch.aborted === "ids" && otherIds.deletes.length === 0, "a different --expect-ids (same count) is refused, no DELETE");
  check(
    (otherLines.at(-1) ?? "") ===
      `Refused: --expect-ids=${digestOf([...noRow.slice(1), id("normal_other")])}, but this run's ids digest to ${digestOf(noRow)}. Run the dry run again and check the list. Nothing changed.`,
    "the refusal prints the two digests only",
  );
  check((await snapshot(all)) === before, "database unchanged after the refused ids");

  // The dry run's own command, parsed as the script would.
  const parsed = parseOptions(command.split(" ").slice(2));
  if ("error" in parsed || "help" in parsed) throw new Error("the dry run's --apply command did not parse");
  const right = fakeClerk(users);
  const applied = await runSweep(parsed, deps(right.fetchFn, []));
  check(applied.aborted === null && applied.deleted === 5 && right.deletes.join(",") === noRow.join(","), `the 5 no-row ids deleted (got ${applied.deleted})`);
  check((await snapshot(teachers)) === teachers.map(() => "teacher:none").join(","), "teachers untouched");
  check((await snapshot(noRow)) === noRow.map(() => "undefined:confirmed").join(","), "deleted hashes confirmed");
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
    await checkEnvironmentMismatch();
    await checkZeroMatch();
    await checkHighShare();
    await checkNormalRun();
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
