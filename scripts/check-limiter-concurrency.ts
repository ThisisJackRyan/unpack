// Checks that the Postgres limiters never admit more than their limit under
// parallel load, through the real neon-http driver and the real limiter
// functions, with a MOCK model (no model calls):
//
// - Join, per IP: JOIN_IP_LIMIT + --extra parallel attempts from one
//   (hashed) IP, each with its own code: exactly JOIN_IP_LIMIT admitted
//   and recorded. Per code: JOIN_CODE_LIMIT + --extra from many IPs with
//   one code: exactly JOIN_CODE_LIMIT. The retry time is the oldest
//   counted attempt plus the window, and names the right key.
// - The student "Try again" throttle: --students students at once, each
//   sending a burst of --burst Try agains (retrying while pending, as the
//   page does) against a model that answers unusably: exactly
//   STUDENT_GENERATION_WINDOW_LIMIT model calls and call rows each, the
//   rest throttled, with a retry time.
// - Link fetches: LINK_FETCH_LIMIT + --extra parallel: exactly
//   LINK_FETCH_LIMIT. Question generations: QUESTION_GENERATION_LIMIT +
//   --extra parallel: exactly QUESTION_GENERATION_LIMIT. Both with a
//   retry time.
// Every round uses fresh keys and rows; --rounds rounds.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-limiter-concurrency [flags]
//
// Flags:
//   --rounds=3     rounds (default 3)
//   --extra=40     attempts past each limit per burst (default 40)
//   --students=4   students bursting Try again at once (default 4)
//   --burst=12     Try agains per student (default 12)
//
// Same database guard, connection cap (DB_CHECK_CONCURRENCY, default 8
// queries in flight, however many requests are started at once), and
// NEON_FETCH_ENDPOINT handling as every check (scripts/lib/db-check.ts).
// Writes a teacher named test_limits_<run> (deleted at the end with
// everything under it) and join_attempts rows under random test keys
// (deleted at the end). Never run against production.
import { randomBytes } from "node:crypto";
import { getSql } from "@/db";
import { QuestionWriterError } from "@/lib/ai/questions";
import {
  checkJoinLimit,
  JOIN_CODE_LIMIT,
  JOIN_IP_LIMIT,
  JOIN_WINDOW_MINUTES,
  joinRetryFromRows,
  joinRetryStatement,
} from "@/lib/join-rate-limit";
import { linkFetchRetryAt, recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { LINK_FETCH_LIMIT, LINK_FETCH_WINDOW_MINUTES } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { questionGenerationRetryAt, recordQuestionGeneration } from "@/lib/question-generation-attempts";
import { QUESTION_GENERATION_LIMIT, QUESTION_GENERATION_WINDOW_MINUTES } from "@/lib/question-rate-limit";
import { getOrCreateStudentQuestions } from "@/lib/student-questions";
import {
  STUDENT_GENERATION_WINDOW_LIMIT,
  STUDENT_GENERATION_WINDOW_MINUTES,
  type StudentQuestionsResult,
  type StudentQuestionWriter,
} from "@/lib/student-questions-core";
import { prepareDbCheck } from "./lib/db-check";

const { fetchEndpoint, concurrency } = prepareDbCheck();

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

const ROUNDS = intFlag("rounds", 3);
const EXTRA = intFlag("extra", 40);
const STUDENTS = intFlag("students", 4);
const BURST = intFlag("burst", 12);
const RUN_ID = Math.random().toString(36).slice(2, 10);
const BODY = "Mia walked to the river after the storm and found a fox. ".repeat(10);

const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

// A random hex key, shaped like the app's hashes. Never a real IP or code.
const usedHashes = new Set<string>();
function testHash(): string {
  const hash = randomBytes(32).toString("hex");
  usedHashes.add(hash);
  return hash;
}

// The retry time is the oldest counted attempt plus the window: all the
// attempts were made just now, so it is about one window from now.
function aboutOneWindowAway(at: Date | null, minutes: number): boolean {
  if (!at) return false;
  const ms = at.getTime() - Date.now();
  return ms > minutes * 60_000 - 60_000 && ms <= minutes * 60_000 + 5_000;
}

let teacherId = "";
let classId = "";

async function setup() {
  ({ id: teacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_limits_${RUN_ID}`}, 'test@example.invalid', 'paid')
    returning id`));
  ({ id: classId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Limiter check', '4', ${`L${RUN_ID}`.toUpperCase()})
    returning id`));
}

async function checkJoin(round: number) {
  console.log(`\n== JOIN (round ${round}) ==`);
  const ip = testHash();
  const ipResults = await Promise.all(
    Array.from({ length: JOIN_IP_LIMIT + EXTRA }, () => checkJoinLimit({ ipHash: ip, codeHash: testHash() }, neonExecutor)),
  );
  const ipRows = await one<{ n: number }>(sql`
    select count(*)::int as n from join_attempts where key_kind = 'ip' and key_hash = ${ip}`);
  const ipAdmitted = ipResults.filter(Boolean).length;
  check(
    ipAdmitted === JOIN_IP_LIMIT && ipRows.n === JOIN_IP_LIMIT,
    `${JOIN_IP_LIMIT + EXTRA} at once from one IP: ${ipAdmitted} admitted, ${ipRows.n} recorded (limit ${JOIN_IP_LIMIT})`,
  );
  const ipRetry = joinRetryFromRows(await neonExecutor([joinRetryStatement({ ipHash: ip, codeHash: testHash() })]));
  check(
    ipRetry.by === "ip" && aboutOneWindowAway(ipRetry.retryAt, JOIN_WINDOW_MINUTES),
    `...the next join from it frees up in about ${JOIN_WINDOW_MINUTES} minutes (${ipRetry.by}, ${ipRetry.retryAt?.toISOString()})`,
  );

  const code = testHash();
  const codeResults = await Promise.all(
    Array.from({ length: JOIN_CODE_LIMIT + EXTRA }, () => checkJoinLimit({ ipHash: testHash(), codeHash: code }, neonExecutor)),
  );
  const codeRows = await one<{ n: number }>(sql`
    select count(*)::int as n from join_attempts where key_kind = 'code' and key_hash = ${code}`);
  const codeAdmitted = codeResults.filter(Boolean).length;
  check(
    codeAdmitted === JOIN_CODE_LIMIT && codeRows.n === JOIN_CODE_LIMIT,
    `${JOIN_CODE_LIMIT + EXTRA} at once with one code: ${codeAdmitted} admitted, ${codeRows.n} recorded (limit ${JOIN_CODE_LIMIT})`,
  );
  const codeRetry = joinRetryFromRows(await neonExecutor([joinRetryStatement({ ipHash: testHash(), codeHash: code })]));
  check(
    codeRetry.by === "code" && aboutOneWindowAway(codeRetry.retryAt, JOIN_WINDOW_MINUTES),
    `...the code's retry time names the code (${codeRetry.by}, ${codeRetry.retryAt?.toISOString()})`,
  );
}

// The model answered, but not usably: every call counts.
let modelCalls = 0;
const unusable: StudentQuestionWriter = async (_context, hooks) => {
  modelCalls++;
  await new Promise((resolve) => setTimeout(resolve, 20));
  hooks.onModelResponse();
  throw new QuestionWriterError("failed", "invalid output: mock");
};

async function tryUntilAnswered(readingId: string, studentId: string): Promise<StudentQuestionsResult> {
  for (let i = 0; i < 400; i++) {
    const result = await getOrCreateStudentQuestions(readingId, studentId, { write: unusable });
    if (result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("still pending after 400 polls");
}

async function checkTryAgain(round: number) {
  console.log(`\n== TRY AGAIN (round ${round}) ==`);
  const { id: readingId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, ${`Round ${round}`}, ${BODY}, 3, 'per_student', 'published')
    returning id`);
  const students: string[] = [];
  for (let i = 0; i < STUDENTS; i++) {
    const { id } = await one<{ id: string }>(sql`
      insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
      values (${classId}, ${`Testa${round}x${i}`}, 'Ro', ${`testa${round}x${i} ro`}, ${`limits_${RUN_ID}_${round}_${i}`})
      returning id`);
    students.push(id);
  }
  const before = modelCalls;
  const results = await Promise.all(
    students.flatMap((s) => Array.from({ length: BURST }, () => tryUntilAnswered(readingId, s).then((r) => ({ s, r })))),
  );
  const rows = (await sql`
    select student_id, count(*)::int as n from student_question_calls where reading_id = ${readingId} group by student_id`) as {
    student_id: string;
    n: number;
  }[];
  const perStudent = students.map((s) => rows.find((r) => r.student_id === s)?.n ?? 0);
  const throttled = results.filter((x) => x.r.status === "throttled");
  check(
    perStudent.every((n) => n === STUDENT_GENERATION_WINDOW_LIMIT) &&
      modelCalls - before === STUDENTS * STUDENT_GENERATION_WINDOW_LIMIT,
    `${STUDENTS} students x ${BURST} Try agains at once: call rows per student ${perStudent.join(", ")}, ${modelCalls - before} model calls (limit ${STUDENT_GENERATION_WINDOW_LIMIT} each)`,
  );
  check(
    throttled.length === STUDENTS * (BURST - STUDENT_GENERATION_WINDOW_LIMIT) &&
      throttled.every((x) => x.r.status === "throttled" && aboutOneWindowAway(x.r.retryAt, STUDENT_GENERATION_WINDOW_MINUTES)),
    `...the other ${throttled.length} were throttled, each with a retry time about ${STUDENT_GENERATION_WINDOW_MINUTES} minutes away`,
  );
}

async function checkTeacherLimits(round: number) {
  console.log(`\n== LINK FETCH AND QUESTION GENERATION (round ${round}) ==`);
  await sql`delete from link_fetch_attempts where teacher_id = ${teacherId}`;
  await sql`delete from question_generation_attempts where teacher_id = ${teacherId}`;
  const links = await Promise.all(Array.from({ length: LINK_FETCH_LIMIT + EXTRA }, () => recordLinkFetchAttempt(teacherId)));
  const linkRows = await one<{ n: number }>(sql`select count(*)::int as n from link_fetch_attempts where teacher_id = ${teacherId}`);
  check(
    links.filter(Boolean).length === LINK_FETCH_LIMIT && linkRows.n === LINK_FETCH_LIMIT,
    `${LINK_FETCH_LIMIT + EXTRA} link fetches at once: ${links.filter(Boolean).length} admitted, ${linkRows.n} recorded (limit ${LINK_FETCH_LIMIT})`,
  );
  check(aboutOneWindowAway(await linkFetchRetryAt(teacherId), LINK_FETCH_WINDOW_MINUTES), "...with a retry time one window away");

  const gens = await Promise.all(
    Array.from({ length: QUESTION_GENERATION_LIMIT + EXTRA }, () => recordQuestionGeneration(teacherId)),
  );
  const genRows = await one<{ n: number }>(sql`
    select count(*)::int as n from question_generation_attempts where teacher_id = ${teacherId}`);
  check(
    gens.filter(Boolean).length === QUESTION_GENERATION_LIMIT && genRows.n === QUESTION_GENERATION_LIMIT,
    `${QUESTION_GENERATION_LIMIT + EXTRA} question generations at once: ${gens.filter(Boolean).length} admitted, ${genRows.n} recorded (limit ${QUESTION_GENERATION_LIMIT})`,
  );
  check(
    aboutOneWindowAway(await questionGenerationRetryAt(teacherId), QUESTION_GENERATION_WINDOW_MINUTES),
    "...with a retry time one window away",
  );
}

async function cleanup(): Promise<void> {
  await sql`delete from teachers where clerk_user_id = ${`test_limits_${RUN_ID}`}`;
  const hashes = [...usedHashes];
  // In slices, so one statement's parameters stay small.
  let deleted = 0;
  for (let i = 0; i < hashes.length; i += 500) {
    const rows = await sql`delete from join_attempts where key_hash = any(${hashes.slice(i, i + 500)}) returning id`;
    deleted += rows.length;
  }
  console.log(`\ncleanup: deleted the test teacher (and everything under it) and ${deleted} join_attempts rows`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(
    `run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}, at most ${concurrency} queries in flight`,
  );
  try {
    await setup();
    for (let round = 1; round <= ROUNDS; round++) {
      await checkJoin(round);
      await checkTryAgain(round);
      await checkTeacherLimits(round);
    }
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
  console.error("check-limiter-concurrency crashed:", error);
  process.exit(1);
});
