// Checks student join through the real neon-http driver and the real app
// functions, with a MOCK model (no model calls):
//
// - Same-name race: --name-n parallel joins with one name (varying case and
//   spacing) into one class -> exactly 1 student, the rest "name_taken",
//   no errors. --rounds rounds, each on a fresh class.
// - Per-IP limit race: 90 parallel joins from one IP hash with distinct
//   names -> exactly JOIN_IP_LIMIT joined, the rest "limited", and exactly
//   JOIN_IP_LIMIT rows for that key.
// - Per-code limit race: 140 parallel joins from distinct IPs into one code
//   -> exactly JOIN_CODE_LIMIT joined.
// - Unknown and turned-off codes are refused alike; the session lookup works
//   by hash; a straight and a curly apostrophe are the same name; neither
//   the raw token nor a raw IP is stored; expired attempt
//   rows are pruned; turning a code off keeps joined students in.
// - Reading views: the class home (listReadingsWithStatus) lists the
//   published readings, draft hidden, all Not started; a per-student
//   reading in the student's class is ready
//   (mock model); a student from another class gets not_found; a shared
//   reading shows its shared questions; a draft is not_found; the teacher's
//   student set list shows the new set.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-student-join [flags]
//
// Flags:
//   --name-n=50          parallel same-name joins per round (default 50)
//   --rounds=3           same-name rounds (default 3)
//   --db-concurrency=60  most DB requests in flight (default 60). All joins
//                        start at once; this only keeps a local Postgres
//                        (max_connections 100, one connection per proxied
//                        request) from refusing connections.
//
// Same host guard and NEON_FETCH_ENDPOINT handling as check-class-limit.ts;
// set CHECK_CLASS_LIMIT_HOST to opt in for one Neon dev branch. Writes a
// teacher named test_join_<run> and deletes it (and everything under it, by
// cascade) and this run's join_attempts rows at the end. Never run against
// production.
import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import { hashJoinCode, hashJoinIp } from "@/lib/client-ip";
import { JOIN_CODE_LIMIT, JOIN_IP_LIMIT, JOIN_WINDOW_MINUTES } from "@/lib/join-rate-limit";
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { listReadingsWithStatus } from "@/lib/reading-progress-db";
import { findStudentBySessionToken, type StudentSession } from "@/lib/student-lookup";
import { joinClass } from "@/lib/student-join";
import type { JoinOutcome } from "@/lib/student-join-core";
import { getOrCreateStudentQuestions } from "@/lib/student-questions";
import { perStudentView } from "@/lib/student-reading-view";
import { loadStudentReading } from "@/lib/student-readings";
import { hashSessionToken } from "@/lib/student-session-token";
import { listStudentSets } from "@/lib/student-sets-db";
import { validateJoin } from "@/lib/validate-join";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Refusing to run.");
  process.exit(2);
}
const LOCAL_DB_HOSTS = ["localhost", "127.0.0.1", "::1", "db.localtest.me"];
let dbHost: string;
try {
  dbHost = new URL(process.env.DATABASE_URL).hostname.replace(/^\[|\]$/g, "");
} catch {
  console.error("DATABASE_URL is not a valid URL. Refusing to run.");
  process.exit(2);
}
if (
  !LOCAL_DB_HOSTS.includes(dbHost) &&
  process.env.CHECK_CLASS_LIMIT_HOST !== dbHost
) {
  console.error(
    `Refusing to run against database host "${dbHost}". This script writes ` +
      `and deletes rows, so it only runs against ${LOCAL_DB_HOSTS.join(", ")} ` +
      `by default. To use a Neon dev branch, set CHECK_CLASS_LIMIT_HOST=${dbHost}. ` +
      "Never use production.",
  );
  process.exit(2);
}
if (process.env.ALLOW_DB_WRITES !== "1") {
  console.error(
    "This script writes and deletes rows. Set ALLOW_DB_WRITES=1 to run it.",
  );
  process.exit(2);
}
// Belt and braces: the mock model is always injected, but make sure no
// code path could reach the model with real credentials.
for (const name of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[name];
const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
if (fetchEndpoint) {
  neonConfig.fetchEndpoint = () => fetchEndpoint;
}

function intFlag(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const NAME_N = intFlag("name-n", 50);
const ROUNDS = intFlag("rounds", 3);
const DB_CONCURRENCY = intFlag("db-concurrency", 60);
const IP_BURST = 90;
const CODE_BURST = 140;
const RUN_ID = Math.random().toString(36).slice(2, 10);
const BODY = "Mia walked to the river after the storm and found a fox. ".repeat(10);
const PROMPTS = ["Why did Mia go to the river?", "What did the fox do?", "What do you think, and why?"];

const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

// neonExecutor with at most `limit` batches in flight.
function throttled(limit: number): StatementExecutor {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (statements) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await neonExecutor(statements);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const execute = throttled(DB_CONCURRENCY);
const pause = () => new Promise((resolve) => setTimeout(resolve, 2_000));

// Every key hash this run uses, for cleanup.
const usedHashes = new Set<string>();
function ipKey(label: string): string {
  const hash = hashJoinIp(`check-${RUN_ID}-${label}`);
  usedHashes.add(hash);
  return hash;
}

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

let teacherId = "";
let classCount = 0;

async function newClass(active = true): Promise<{ id: string; code: string }> {
  const code = `J${RUN_ID}${classCount++}`.toUpperCase().slice(0, 12);
  usedHashes.add(hashJoinCode(code));
  const { id } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code, code_active)
    values (${teacherId}, ${`Join check ${classCount}`}, '4', ${code}, ${active})
    returning id`);
  return { id, code };
}

// Joins through validateJoin, as the action does.
async function join(code: string, firstName: string, lastInitials: string, ipHash: string): Promise<JoinOutcome> {
  const result = validateJoin({ code, firstName, lastInitials });
  if (!result.ok) throw new Error(`validation failed: ${JSON.stringify(result.errors)}`);
  return joinClass(result.data, ipHash, { execute });
}

function tally(settled: PromiseSettledResult<JoinOutcome>[]) {
  const statuses: Record<string, number> = {};
  const thrown: string[] = [];
  for (const r of settled) {
    if (r.status === "rejected") thrown.push(String((r.reason as Error)?.message));
    else statuses[r.value.status] = (statuses[r.value.status] ?? 0) + 1;
  }
  return { statuses, thrown };
}

async function countStudents(classId: string): Promise<number> {
  return (await one<{ n: number }>(sql`select count(*)::int as n from students where class_id = ${classId}`)).n;
}

async function countAttempts(kind: string, hash: string): Promise<number> {
  return (
    await one<{ n: number }>(sql`
      select count(*)::int as n from join_attempts where key_kind = ${kind} and key_hash = ${hash}`)
  ).n;
}

const NAME_VARIANTS: [string, string][] = [
  ["Maya", "Ro"],
  ["maya", "ro"],
  [" MAYA ", "RO"],
  ["Maya", "rO"],
  ["  maya", " Ro "],
];

async function checkSameNameRace() {
  console.log(`\n== SAME-NAME RACE: ${ROUNDS} rounds x ${NAME_N} parallel joins ==`);
  for (let round = 1; round <= ROUNDS; round++) {
    const { id, code } = await newClass();
    const settled = await Promise.allSettled(
      Array.from({ length: NAME_N }, (_, i) => {
        const [first, last] = NAME_VARIANTS[i % NAME_VARIANTS.length];
        return join(code.toLowerCase(), first, last, ipKey(`name-${round}-${i}`));
      }),
    );
    const { statuses, thrown } = tally(settled);
    const students = await countStudents(id);
    console.log(`round ${round}: results ${JSON.stringify(statuses)}, threw ${thrown.length}, student rows ${students}`);
    check(
      statuses.joined === 1 && statuses.name_taken === NAME_N - 1 && thrown.length === 0 && students === 1,
      `round ${round}: joined ${statuses.joined ?? 0}, name_taken ${statuses.name_taken ?? 0}, errors ${thrown.length}, rows ${students} (want 1/${NAME_N - 1}/0/1)` +
        (thrown.length ? `: ${[...new Set(thrown)].join("; ").slice(0, 300)}` : ""),
    );
    await pause();
  }
}

async function checkIpLimit() {
  console.log(`\n== PER-IP LIMIT RACE: ${IP_BURST} parallel joins from one IP, limit ${JOIN_IP_LIMIT} ==`);
  const { id, code } = await newClass();
  const ip = ipKey("one-ip");
  const settled = await Promise.allSettled(
    Array.from({ length: IP_BURST }, (_, i) => join(code, `Kid${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}`, "Q", ip)),
  );
  const { statuses, thrown } = tally(settled);
  const rows = await countAttempts("ip", ip);
  const students = await countStudents(id);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}, ip rows ${rows}, student rows ${students}`);
  check(
    statuses.joined === JOIN_IP_LIMIT && statuses.limited === IP_BURST - JOIN_IP_LIMIT && thrown.length === 0 &&
      rows === JOIN_IP_LIMIT && students === JOIN_IP_LIMIT,
    `joined ${statuses.joined ?? 0}, limited ${statuses.limited ?? 0}, errors ${thrown.length}, ip rows ${rows}, students ${students} ` +
      `(want ${JOIN_IP_LIMIT}/${IP_BURST - JOIN_IP_LIMIT}/0/${JOIN_IP_LIMIT}/${JOIN_IP_LIMIT})`,
  );
  const after = await join(code, "Late", "Q", ip);
  check(after.status === "limited", `next join from that IP: ${after.status}`);
}

async function checkCodeLimit() {
  console.log(`\n== PER-CODE LIMIT RACE: ${CODE_BURST} parallel joins from distinct IPs, limit ${JOIN_CODE_LIMIT} ==`);
  const { id, code } = await newClass();
  const settled = await Promise.allSettled(
    Array.from({ length: CODE_BURST }, (_, i) =>
      join(code, `Kid${"abcdefghij"[i % 10]}${"abcdefghijklmno"[Math.floor(i / 10)]}`, "Z", ipKey(`code-${i}`)),
    ),
  );
  const { statuses, thrown } = tally(settled);
  const rows = await countAttempts("code", hashJoinCode(code));
  const students = await countStudents(id);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}, code rows ${rows}, student rows ${students}`);
  check(
    statuses.joined === JOIN_CODE_LIMIT && statuses.limited === CODE_BURST - JOIN_CODE_LIMIT && thrown.length === 0 &&
      rows === JOIN_CODE_LIMIT && students === JOIN_CODE_LIMIT,
    `joined ${statuses.joined ?? 0}, limited ${statuses.limited ?? 0}, errors ${thrown.length}, code rows ${rows}, students ${students} ` +
      `(want ${JOIN_CODE_LIMIT}/${CODE_BURST - JOIN_CODE_LIMIT}/0/${JOIN_CODE_LIMIT}/${JOIN_CODE_LIMIT})`,
  );
}

async function checkCodesAndSessions(): Promise<{ classId: string; code: string; session: StudentSession }> {
  console.log("\n== CODES, SESSIONS, STORAGE ==");
  const off = await newClass(false);
  const unknownCode = `Z${RUN_ID}`.toUpperCase();
  usedHashes.add(hashJoinCode(unknownCode));
  const unknown = await join(unknownCode, "Maya", "Ro", ipKey("unknown"));
  const inactive = await join(off.code, "Maya", "Ro", ipKey("inactive"));
  check(
    unknown.status === "class_not_found" && inactive.status === "class_not_found",
    `unknown code: ${unknown.status}; turned-off code: ${inactive.status} (same answer)`,
  );
  check((await countStudents(off.id)) === 0, "no student added to the turned-off class");

  const { id: classId, code } = await newClass();
  const rawIp = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const realIpHash = hashJoinIp(rawIp);
  usedHashes.add(realIpHash);
  const joined = await join(code, "Maya", "Ro", realIpHash);
  if (joined.status !== "joined") throw new Error(`join failed: ${joined.status}`);
  const stored = await one<{ hash: string; whole: string }>(sql`
    select session_token_hash as hash, s::text as whole from students s where id = ${joined.studentId}`);
  check(stored.hash === hashSessionToken(joined.token), "session_token_hash is the SHA-256 of the token");
  check(!stored.whole.includes(joined.token), "raw token is not in the student row");
  const rawAnywhere = await one<{ n: number }>(sql`
    select (select count(*) from students s where s::text like ${`%${joined.token}%`})
      + (select count(*) from join_attempts j where j::text like ${`%${joined.token}%`}) as n`);
  check(Number(rawAnywhere.n) === 0, `raw token found in students/join_attempts: ${rawAnywhere.n} rows`);
  const ipRows = await one<{ hashed: number; raw: number }>(sql`
    select
      (select count(*)::int from join_attempts where key_hash = ${realIpHash}) as hashed,
      (select count(*)::int from join_attempts where key_hash like ${`%${rawIp}%`}) as raw`);
  check(ipRows.hashed === 1 && ipRows.raw === 0, `IP stored hashed (${ipRows.hashed} row), raw IP rows ${ipRows.raw}`);

  const session = await findStudentBySessionToken(joined.token);
  check(
    session?.student.id === joined.studentId && session.class.id === classId && session.student.firstName === "Maya",
    `lookup by token hash finds the student (${session?.student.firstName} ${session?.student.lastInitials})`,
  );
  check((await findStudentBySessionToken(hashSessionToken(joined.token))) === null, "the stored hash itself is not a valid token");
  check((await findStudentBySessionToken("not-a-token")) === null, "unknown token: no session");

  const again = await join(code, "MAYA", "ro", ipKey("again"));
  const twoLetters = await join(code, "Maya", "R", ipKey("one-letter"));
  check(again.status === "name_taken", `same name again: ${again.status} (refused, never resumed)`);
  check(twoLetters.status === "joined", `"Maya R" next to "Maya Ro": ${twoLetters.status}`);
  const straight = await join(code, "D'Andre", "Sm", ipKey("straight-apostrophe"));
  const curly = await join(code, "D’Andre", "Sm", ipKey("curly-apostrophe"));
  check(
    straight.status === "joined" && curly.status === "name_taken",
    `"D'Andre Sm" then "D’Andre Sm": ${straight.status}, ${curly.status} (want joined, name_taken)`,
  );

  await sql`update classes set code_active = false where id = ${classId}`;
  const stillIn = await findStudentBySessionToken(joined.token);
  const late = await join(code, "Leo", "M", ipKey("late"));
  check(stillIn?.student.id === joined.studentId, "code turned off: joined student keeps their session");
  check(late.status === "class_not_found", `code turned off: new join ${late.status}`);
  await sql`update classes set code_active = true where id = ${classId}`;

  // Prune: an attempt older than the window goes on the next join.
  const oldHash = ipKey("old");
  await sql`
    insert into join_attempts (key_kind, key_hash, created_at)
    values ('ip', ${oldHash}, now() - make_interval(mins => ${JOIN_WINDOW_MINUTES + 1}))`;
  await join(code, "Prune", "P", ipKey("prune"));
  check((await countAttempts("ip", oldHash)) === 0, "expired attempt row pruned by the next join");

  return { classId, code, session: session! };
}

async function checkReadings(classId: string, session: StudentSession) {
  console.log("\n== STUDENT READING VIEWS ==");
  const add = async (title: string, mode: string, status: string) =>
    (
      await one<{ id: string }>(sql`
        insert into readings (class_id, title, body_text, question_count, question_mode, status)
        values (${classId}, ${title}, ${BODY}, 3, ${mode}::question_mode, ${status}::reading_status)
        returning id`)
    ).id;
  const perStudent = await add("Per-student", "per_student", "published");
  const shared = await add("Shared", "shared", "published");
  const draft = await add("Draft", "shared", "draft");
  await sql`
    insert into questions (reading_id, student_id, position, prompt)
    select ${shared}::uuid, null, p, 'Shared ' || p from generate_series(1, 3) as p`;

  let calls = 0;
  const write = async () => {
    calls++;
    return PROMPTS;
  };

  // What the class home shows.
  const list = await listReadingsWithStatus(classId, session.student.id);
  check(
    list.length === 2 && list.every((r) => r.id !== draft) && list.every((r) => r.status === "not_started"),
    `home lists ${list.length} published readings (draft hidden), all not_started`,
  );

  const mine = await loadStudentReading(session, perStudent, { write });
  check(
    mine.view.kind === "questions" && mine.view.questions.map((q) => q.prompt).join("|") === PROMPTS.join("|") && calls === 1,
    `per-student reading: ${mine.view.kind}, ${mine.view.kind === "questions" ? mine.view.questions.length : 0} questions, model calls ${calls}`,
  );
  const reopen = await loadStudentReading(session, perStudent, { write });
  check(reopen.view.kind === "questions" && calls === 1, "reopening reuses the cached set");

  const sharedView = await loadStudentReading(session, shared, { write });
  check(
    sharedView.view.kind === "questions" && sharedView.view.questions.map((q) => q.prompt).join("|") === "Shared 1|Shared 2|Shared 3",
    `shared reading: ${sharedView.view.kind} with the shared questions`,
  );
  const draftView = await loadStudentReading(session, draft, { write });
  check(draftView.view.kind === "not_found" && draftView.reading === null, `draft reading: ${draftView.view.kind}`);
  const bogus = await loadStudentReading(session, "not-a-uuid", { write });
  check(bogus.view.kind === "not_found", `malformed id: ${bogus.view.kind}`);

  // A student from another class.
  const other = await newClass();
  const outsider = await join(other.code, "Omar", "Ou", ipKey("outsider"));
  if (outsider.status !== "joined") throw new Error(`outsider join failed: ${outsider.status}`);
  const outsiderSession = (await findStudentBySessionToken(outsider.token))!;
  const viaPage = await loadStudentReading(outsiderSession, perStudent, { write });
  const raw = await getOrCreateStudentQuestions(perStudent, outsider.studentId, { write });
  check(
    viaPage.view.kind === "not_found" && raw.status === "not_allowed" && perStudentView(raw).kind === "not_found" && calls === 1,
    `other class: page ${viaPage.view.kind}; core ${raw.status} -> view ${perStudentView(raw).kind}; model calls still ${calls}`,
  );
  const outsiderShared = await loadStudentReading(outsiderSession, shared, { write });
  check(outsiderShared.view.kind === "not_found", `other class, shared reading: ${outsiderShared.view.kind}`);

  const sets = await listStudentSets(perStudent, classId);
  check(
    sets.length === 1 && sets[0].name === "Maya Ro" && sets[0].questions.length === 3,
    `teacher sees ${sets.length} student set (${sets[0]?.name}, ${sets[0]?.questions.length} questions)`,
  );
  check((await listStudentSets(perStudent, other.id)).length === 0, "another class's id lists no sets");
}

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id = ${`test_join_${RUN_ID}`} returning id`;
  const attempts = await sql.query(
    "delete from join_attempts where key_hash = any($1::text[]) returning id",
    [[...usedHashes]],
  );
  console.log(
    `\ncleanup: deleted ${rows.length} test teacher (and everything under it), ${attempts.length} join_attempts rows`,
  );
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}, db concurrency ${DB_CONCURRENCY}`);
  try {
    ({ id: teacherId } = await one<{ id: string }>(sql`
      insert into teachers (clerk_user_id, email, plan)
      values (${`test_join_${RUN_ID}`}, 'test@example.invalid', 'paid')
      returning id`));
    await checkSameNameRace();
    await checkIpLimit();
    await pause();
    await checkCodeLimit();
    await pause();
    const { classId, session } = await checkCodesAndSessions();
    await checkReadings(classId, session);
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
  console.error("check-student-join crashed:", error);
  process.exit(1);
});
