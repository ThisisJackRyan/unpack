// Checks the abuse protection PR through the real neon-http driver and the
// real app functions, with a MOCK model (no model calls):
//
// - The "Try again" throttle on a student's own question set: a burst of
//   --burst parallel Try agains (each retrying while pending, as the page
//   does) against a failing model makes exactly
//   STUDENT_GENERATION_WINDOW_LIMIT model calls, the rest "throttled";
//   after the window (rows moved back in time) exactly as many more, up to
//   STUDENT_GENERATION_CALL_LIMIT; at that cap another burst makes no
//   call ("calls_used_up"). A working model is called once, and cached
//   opens add no call rows. The failing model answers with unusable
//   output, which counts.
// - Provider failures are given back: a model throwing a 529 overloaded,
//   a 503, a 401 bad key, a 402 out of credits, or a network error fills
//   the window like any call (STUDENT_GENERATION_WINDOW_LIMIT calls, then
//   "throttled" with no model call) but never counts toward
//   STUDENT_GENERATION_CALL_LIMIT: window after window, more calls than
//   the cap, none counted, never "calls_used_up", and the student then
//   still gets a set. A burst
//   against an outage makes one call at a time, exactly the window limit.
// - "Let them try again": at the cap, class status says Needs a reset;
//   another teacher's reset is not_found with every call row intact; the
//   owner's reset clears them, the student gets the full budget again
//   (a burst makes STUDENT_GENERATION_WINDOW_LIMIT calls), and a repeat
//   reset is a no-op success.
// - New join code: --regen-n concurrent regenerates end with exactly one
//   current code; it joins; the original and every other returned code
//   refuse. Another teacher can't regenerate or toggle.
// - On/off: a code turned off refuses joins (same as unknown), turned back
//   on it works. A joined student's session still works after a new code
//   and with the code off.
// - Student delete: removes exactly that student's rows in every student
//   table (counted per table before and after) and nothing of another
//   student in the same class; another teacher gets not_found with every
//   row intact; the deleted student's session no longer resolves; a
//   second delete is a no-op success (already_gone), and another
//   teacher's delete of the gone id is still not_found.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-abuse-protection [flags]
//
// Flags:
//   --burst=20     parallel Try agains per burst (default 20)
//   --regen-n=20   concurrent regenerates (default 20)
//
// Same database guard, connection cap, and NEON_FETCH_ENDPOINT handling as
// every check (scripts/lib/db-check.ts). Writes
// teachers named test_abuse_<run> and test_abuse_other_<run> and deletes
// them (and everything under them, by cascade) and this run's
// join_attempts rows at the end. Never run against production.
import { getSql } from "@/db";
import { QuestionWriterError } from "@/lib/ai/questions";
import { loadClassStatus } from "@/lib/class-status-db";
import { cellKey } from "@/lib/class-status";
import { deleteStudent, newJoinCode, resetStudentQuestionCalls, setJoinCodeActive } from "@/lib/classes";
import { hashJoinCode, hashJoinIp } from "@/lib/client-ip";
import { findStudentBySessionToken } from "@/lib/student-lookup";
import { gatewayErrors, retried } from "@/lib/ai/test-fixtures";
import { joinClass } from "@/lib/student-join";
import type { JoinOutcome } from "@/lib/student-join-core";
import { getOrCreateStudentQuestions } from "@/lib/student-questions";
import {
  STUDENT_GENERATION_CALL_LIMIT,
  STUDENT_GENERATION_WINDOW_LIMIT,
  STUDENT_GENERATION_WINDOW_MINUTES,
  type StudentQuestionsResult,
  type StudentQuestionWriter,
} from "@/lib/student-questions-core";
import { validateJoin } from "@/lib/validate-join";
import { prepareDbCheck } from "./lib/db-check";

const { fetchEndpoint } = prepareDbCheck();

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

const BURST = intFlag("burst", 20);
const REGEN_N = intFlag("regen-n", 20);
const RUN_ID = Math.random().toString(36).slice(2, 10);
const BODY = "Mia walked to the river after the storm and found a fox. ".repeat(10);
const PROMPTS = ["Why did Mia go to the river?", "What did the fox do?", "What do you think, and why?"];

const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

// Every key hash this run uses, for cleanup.
const usedHashes = new Set<string>();
let ipCount = 0;
function freshIp(): string {
  const hash = hashJoinIp(`check-abuse-${RUN_ID}-${ipCount++}`);
  usedHashes.add(hash);
  return hash;
}

// Joins through validateJoin, as the action does, each from its own IP so
// the per-IP limit never gets in the way.
async function join(code: string, firstName: string, lastInitials: string): Promise<JoinOutcome> {
  usedHashes.add(hashJoinCode(code));
  const result = validateJoin({ code, firstName, lastInitials });
  if (!result.ok) throw new Error(`validation failed: ${JSON.stringify(result.errors)}`);
  return joinClass(result.data, freshIp());
}

let teacherId = "";
let otherTeacherId = "";
let classId = "";
let readingId = "";
let otherClassOfOther = "";
let joinCode = "";

async function setup() {
  ({ id: teacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_abuse_${RUN_ID}`}, 'test@example.invalid', 'paid')
    returning id`));
  ({ id: otherTeacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_abuse_other_${RUN_ID}`}, 'other@example.invalid', 'paid')
    returning id`));
  joinCode = `A${RUN_ID}`.toUpperCase();
  usedHashes.add(hashJoinCode(joinCode));
  ({ id: classId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Abuse check', '4', ${joinCode})
    returning id`));
  ({ id: otherClassOfOther } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${otherTeacherId}, 'Other teacher class', '4', ${`C${RUN_ID}`.toUpperCase()})
    returning id`));
  ({ id: readingId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Per-student check', ${BODY}, ${PROMPTS.length}, 'per_student', 'published')
    returning id`));
}

async function newStudent(firstName: string): Promise<{ id: string; token: string }> {
  const outcome = await join(joinCode, firstName, "Ro");
  if (outcome.status !== "joined") throw new Error(`setup join failed: ${outcome.status}`);
  return { id: outcome.studentId, token: outcome.token };
}

// ---------------------------------------------------------------------------
// The Try again throttle

let modelCalls = 0;
// The model answered, but not usably: counts toward the throttle.
const failingModel: StudentQuestionWriter = async (_context, hooks) => {
  modelCalls++;
  await new Promise((resolve) => setTimeout(resolve, 50));
  hooks.onModelResponse();
  throw new QuestionWriterError("failed", "invalid output: mock");
};
// No answer came back: doesn't count.
function downModel(error: Error): StudentQuestionWriter {
  return async () => {
    modelCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw error;
  };
}
const workingModel = async (): Promise<string[]> => {
  modelCalls++;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return PROMPTS;
};

// One Try again, retried while another request holds the claim, the way
// the page refreshes itself while pending.
async function tryUntilAnswered(studentId: string, write: StudentQuestionWriter): Promise<StudentQuestionsResult> {
  for (let i = 0; i < 400; i++) {
    const result = await getOrCreateStudentQuestions(readingId, studentId, { write });
    if (result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("still pending after 400 polls");
}

async function burst(studentId: string, write: StudentQuestionWriter) {
  const before = modelCalls;
  const results = await Promise.all(Array.from({ length: BURST }, () => tryUntilAnswered(studentId, write)));
  const statuses: Record<string, number> = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return { calls: modelCalls - before, statuses };
}

// Every call row (the window counts them all).
async function callRows(studentId: string): Promise<number> {
  return (
    await one<{ n: number }>(sql`
      select count(*)::int as n from student_question_calls
      where reading_id = ${readingId} and student_id = ${studentId}`)
  ).n;
}

// The rows that count toward the lifetime limit (not given back).
async function countedRows(studentId: string): Promise<number> {
  return (
    await one<{ n: number }>(sql`
      select count(*)::int as n from student_question_calls
      where reading_id = ${readingId} and student_id = ${studentId} and not given_back`)
  ).n;
}

// Moves this student's call rows back past the window, as if the break
// had been taken.
async function passTheWindow(studentId: string) {
  await sql`
    update student_question_calls
    set created_at = created_at - make_interval(mins => ${STUDENT_GENERATION_WINDOW_MINUTES + 1})
    where reading_id = ${readingId} and student_id = ${studentId}`;
}

async function checkThrottle() {
  console.log(
    `\n== TRY AGAIN THROTTLE: bursts of ${BURST}, ${STUDENT_GENERATION_WINDOW_LIMIT} per ${STUDENT_GENERATION_WINDOW_MINUTES} minutes, ${STUDENT_GENERATION_CALL_LIMIT} in all ==`,
  );
  const student = await newStudent("Throttle");

  const first = await burst(student.id, failingModel);
  console.log(`burst 1: ${JSON.stringify(first)}`);
  check(first.calls === STUDENT_GENERATION_WINDOW_LIMIT, `burst 1 made exactly ${STUDENT_GENERATION_WINDOW_LIMIT} model calls (got ${first.calls})`);
  check(first.statuses.error === first.calls && first.statuses.throttled === BURST - first.calls, "the rest were throttled");
  check((await callRows(student.id)) === STUDENT_GENERATION_WINDOW_LIMIT, "one call row per model call");

  const atLimit = await burst(student.id, failingModel);
  check(atLimit.calls === 0 && atLimit.statuses.throttled === BURST, `inside the window: no model call, all throttled (${JSON.stringify(atLimit)})`);

  // Window by window up to the lifetime cap.
  let total = first.calls;
  while (total < STUDENT_GENERATION_CALL_LIMIT) {
    await passTheWindow(student.id);
    const next = await burst(student.id, failingModel);
    const expected = Math.min(STUDENT_GENERATION_WINDOW_LIMIT, STUDENT_GENERATION_CALL_LIMIT - total);
    console.log(`after the window: ${JSON.stringify(next)}`);
    check(next.calls === expected, `after the window: exactly ${expected} more model calls (got ${next.calls})`);
    total += next.calls;
    if (next.calls === 0) break;
  }
  check((await callRows(student.id)) === STUDENT_GENERATION_CALL_LIMIT, `call rows at the cap: ${STUDENT_GENERATION_CALL_LIMIT}`);

  await passTheWindow(student.id);
  const capped = await burst(student.id, workingModel);
  check(
    capped.calls === 0 && capped.statuses.calls_used_up === BURST,
    `at the cap, even after the window and with a working model: no call, all calls_used_up (${JSON.stringify(capped)})`,
  );
  check((await callRows(student.id)) === STUDENT_GENERATION_CALL_LIMIT, "the cap writes no more call rows");

  await checkReset(student.id);

  const fine = await newStudent("Smooth");
  const ok = await burst(fine.id, workingModel);
  check(ok.calls === 1 && ok.statuses.ready === BURST, `a working model: 1 call, all ready (${JSON.stringify(ok)})`);
  const again = await burst(fine.id, workingModel);
  check(again.calls === 0 && (await callRows(fine.id)) === 1, "cached opens make no call and add no call row");
}

async function needsReset(studentId: string, asTeacher = teacherId): Promise<boolean | undefined> {
  const status = await loadClassStatus(classId, asTeacher);
  return status.cells[cellKey(studentId, readingId)]?.needsReset;
}

// "Let them try again", on a student at the cap.
async function checkReset(studentId: string) {
  console.log("\n== LET THEM TRY AGAIN ==");
  check((await needsReset(studentId)) === true, "class status: Needs a reset at the cap");

  const intruder = await resetStudentQuestionCalls(classId, otherTeacherId, studentId, readingId);
  check(intruder.status === "not_found", `another teacher's reset: ${intruder.status}`);
  check((await callRows(studentId)) === STUDENT_GENERATION_CALL_LIMIT, "...and every call row is intact");
  const { id: otherReading } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    select ${otherClassOfOther}, 'Other teacher reading', ${BODY}, 3, 'per_student', 'published' returning id`);
  check(
    (await resetStudentQuestionCalls(classId, teacherId, studentId, otherReading)).status === "not_found",
    "the owner can't reset through another class's reading",
  );

  const reset = await resetStudentQuestionCalls(classId, teacherId, studentId, readingId);
  check(reset.status === "reset" && reset.cleared === STUDENT_GENERATION_CALL_LIMIT, `the owner's reset: ${JSON.stringify(reset)}`);
  check((await callRows(studentId)) === 0, "the call rows are gone");
  check((await needsReset(studentId)) === false, "class status: no longer Needs a reset");
  const again = await resetStudentQuestionCalls(classId, teacherId, studentId, readingId);
  check(again.status === "reset" && again.cleared === 0, `a repeat reset is a no-op success: ${JSON.stringify(again)}`);

  const after = await burst(studentId, failingModel);
  check(
    after.calls === STUDENT_GENERATION_WINDOW_LIMIT && after.statuses.throttled === BURST - after.calls,
    `after the reset the full budget is back: ${STUDENT_GENERATION_WINDOW_LIMIT} calls, the rest throttled (${JSON.stringify(after)})`,
  );
  await passTheWindow(studentId);
  const ok = await burst(studentId, workingModel);
  check(ok.calls === 1 && ok.statuses.ready === BURST, `and the student can get a set: ${JSON.stringify(ok)}`);
}

// Provider failures are given back: they fill the window, not the cap.
async function checkProviderFailures() {
  console.log("\n== PROVIDER FAILURES: COUNT TOWARD THE WINDOW, NOT THE LIFETIME CAP ==");
  // As Vercel AI Gateway and the AI SDK report them.
  const errors: [string, Error][] = [
    ["529 overloaded", retried(gatewayErrors.overloaded())],
    ["503 unavailable", retried(gatewayErrors.unavailable())],
    ["401 bad key", gatewayErrors.wrappedAuthProduction()],
    ["402 out of credits", gatewayErrors.outOfCredits()],
    ["network error", retried(gatewayErrors.network())],
  ];
  const total = STUDENT_GENERATION_CALL_LIMIT + 2;
  for (const [name, error] of errors) {
    const student = await newStudent(`Outage${name.replace(/[^a-z]/gi, "").slice(0, 10)}`);
    const before = modelCalls;
    const statuses: string[] = [];
    const throttledCalls: number[] = [];
    // More calls than the lifetime cap, one full window at a time.
    for (let i = 0; i < total; i++) {
      if (i > 0 && i % STUDENT_GENERATION_WINDOW_LIMIT === 0) {
        const callsBefore = modelCalls;
        const full = await tryUntilAnswered(student.id, downModel(error));
        throttledCalls.push(modelCalls - callsBefore);
        statuses.push(full.status);
        await passTheWindow(student.id);
      }
      statuses.push((await tryUntilAnswered(student.id, downModel(error))).status);
    }
    const throttled = statuses.filter((s) => s === "throttled").length;
    check(
      modelCalls - before === total && statuses.filter((s) => s === "error").length === total,
      `${name}: ${total} failing calls, each reached the model once (${JSON.stringify(statuses)})`,
    );
    check(
      throttled === throttledCalls.length && throttledCalls.every((n) => n === 0),
      `${name}: each full window of given-back calls throttled the next open, with no model call (${throttled}x)`,
    );
    check(!statuses.includes("calls_used_up"), `${name}: never calls_used_up`);
    check((await callRows(student.id)) === total, `${name}: ${total} call rows kept for the window`);
    check((await countedRows(student.id)) === 0, `${name}: none counted toward the lifetime ${STUDENT_GENERATION_CALL_LIMIT}`);
    check((await needsReset(student.id)) === false, `${name}: class status: not Needs a reset`);
    const claims = await one<{ n: number }>(sql`
      select count(*)::int as n from question_generations where reading_id = ${readingId} and student_id = ${student.id}`);
    check(claims.n === 0, `${name}: no claim left behind`);
    await passTheWindow(student.id);
    const ok = await tryUntilAnswered(student.id, workingModel);
    check(ok.status === "ready" && (await countedRows(student.id)) === 1, `${name}: the student can still get a set (${ok.status})`);
  }

  // A burst against an outage: the in-flight call holds the slot, so it's
  // one call at a time, and the given-back calls fill the window.
  const burster = await newStudent("Outageburst");
  const b = await burst(burster.id, downModel(retried(gatewayErrors.unavailable())));
  check(
    b.calls === STUDENT_GENERATION_WINDOW_LIMIT &&
      b.statuses.error === STUDENT_GENERATION_WINDOW_LIMIT &&
      b.statuses.throttled === BURST - STUDENT_GENERATION_WINDOW_LIMIT,
    `a burst of ${BURST} against an outage: exactly ${STUDENT_GENERATION_WINDOW_LIMIT} calls, the rest throttled (${JSON.stringify(b)})`,
  );
  check(
    (await callRows(burster.id)) === STUDENT_GENERATION_WINDOW_LIMIT && (await countedRows(burster.id)) === 0,
    "...all given back: in the window, none counted",
  );
}

// ---------------------------------------------------------------------------
// Join code on/off and new code

async function checkJoinCode() {
  console.log(`\n== JOIN CODE: ${REGEN_N} concurrent new codes, on/off ==`);
  const existing = await newStudent("Existing");
  const original = joinCode;

  const settled = await Promise.allSettled(
    Array.from({ length: REGEN_N }, () => newJoinCode(classId, teacherId)),
  );
  const thrown = settled.filter((r) => r.status === "rejected");
  const codes = settled.flatMap((r) => (r.status === "fulfilled" && r.value.status === "saved" ? [r.value.code] : []));
  codes.forEach((c) => usedHashes.add(hashJoinCode(c)));
  check(thrown.length === 0 && codes.length === REGEN_N, `${REGEN_N} new codes saved, none threw (${thrown.length} threw)`);
  const current = await one<{ join_code: string }>(sql`select join_code from classes where id = ${classId}`);
  check(codes.includes(current.join_code), "the current code is one of the saved ones");
  const matching = await one<{ n: number }>(sql`
    select count(*)::int as n from classes where join_code = any(${[original, ...codes]}::text[])`);
  check(matching.n === 1, `exactly one class row holds any of these codes (got ${matching.n})`);
  joinCode = current.join_code;

  const joined = await join(joinCode, "Newcode", "Ro");
  check(joined.status === "joined", `the current code joins: ${joined.status}`);
  const old = [original, ...codes.filter((c) => c !== joinCode)];
  const oldResults = await Promise.all(old.map((c, i) => join(c, `Oldcode${String.fromCharCode(97 + (i % 26))}`, "Ro")));
  check(
    oldResults.every((r) => r.status === "class_not_found"),
    `every old code refuses (${old.length}): ${JSON.stringify(oldResults.map((r) => r.status).filter((s) => s !== "class_not_found"))}`,
  );
  check((await findStudentBySessionToken(existing.token))?.student.id === existing.id, "an existing session still works after a new code");

  check((await newJoinCode(classId, otherTeacherId)).status === "not_found", "another teacher can't make a new code");
  check((await setJoinCodeActive(classId, otherTeacherId, false)).status === "not_found", "another teacher can't turn the code off");
  const unchanged = await one<{ join_code: string; code_active: boolean }>(sql`
    select join_code, code_active from classes where id = ${classId}`);
  check(unchanged.join_code === joinCode && unchanged.code_active, "...and the class is unchanged");

  const off = await setJoinCodeActive(classId, teacherId, false);
  check(off.status === "saved" && !off.active, "turned the code off");
  const refused = await join(joinCode, "Offcode", "Ro");
  check(refused.status === "class_not_found", `a code that's off refuses, like an unknown one: ${refused.status}`);
  check((await findStudentBySessionToken(existing.token))?.student.id === existing.id, "an existing session still works with the code off");
  const offTwice = await Promise.all([setJoinCodeActive(classId, teacherId, false), setJoinCodeActive(classId, teacherId, false)]);
  check(offTwice.every((r) => r.status === "saved" && !r.active), "off twice at once stays off");

  const on = await setJoinCodeActive(classId, teacherId, true);
  check(on.status === "saved" && on.active, "turned the code back on");
  const back = await join(joinCode, "Oncode", "Ro");
  check(back.status === "joined", `back on, it joins: ${back.status}`);
}

// ---------------------------------------------------------------------------
// Student delete

const STUDENT_TABLES = [
  "students",
  "questions",
  "question_generations",
  "student_question_calls",
  "attempts",
  "answers",
  "effort_checks",
  "challenges",
] as const;

async function studentCounts(studentId: string): Promise<Record<string, number>> {
  const row = await one<Record<string, number>>(sql`
    select
      (select count(*)::int from students where id = ${studentId}) as students,
      (select count(*)::int from questions where student_id = ${studentId}) as questions,
      (select count(*)::int from question_generations where student_id = ${studentId}) as question_generations,
      (select count(*)::int from student_question_calls where student_id = ${studentId}) as student_question_calls,
      (select count(*)::int from attempts where student_id = ${studentId}) as attempts,
      (select count(*)::int from answers a join attempts t on t.id = a.attempt_id where t.student_id = ${studentId}) as answers,
      (select count(*)::int from effort_checks where student_id = ${studentId}) as effort_checks,
      (select count(*)::int from challenges where student_id = ${studentId}) as challenges`);
  return row;
}

// Gives a student a row in every student table: their own set (through
// the app, mock model), three failed tries with answers, finished effort
// checks, and an open challenge.
async function fillStudent(studentId: string) {
  const set = await getOrCreateStudentQuestions(readingId, studentId, { write: async () => PROMPTS });
  if (set.status !== "ready") throw new Error(`setup set failed: ${set.status}`);
  for (let tryNumber = 1; tryNumber <= 3; tryNumber++) {
    const { id: attemptId } = await one<{ id: string }>(sql`
      insert into attempts (student_id, reading_id, try_number, result)
      values (${studentId}, ${readingId}, ${tryNumber}, 'fail') returning id`);
    for (const q of set.questions) {
      await sql`
        insert into answers (attempt_id, question_id, text, ai_pass, ai_feedback)
        values (${attemptId}, ${q.id}, 'idk', false, 'Look at the second paragraph.')`;
    }
    await sql`
      insert into effort_checks (student_id, reading_id, finished_at, outcome)
      values (${studentId}, ${readingId}, now(), 'fail')`;
  }
  await sql`
    insert into challenges (student_id, reading_id, note) values (${studentId}, ${readingId}, 'I really tried.')`;
}

async function checkStudentDelete() {
  console.log("\n== STUDENT DELETE ==");
  const target = await newStudent("Maya");
  const neighbor = await newStudent("Keala");
  await fillStudent(target.id);
  await fillStudent(neighbor.id);

  const targetBefore = await studentCounts(target.id);
  const neighborBefore = await studentCounts(neighbor.id);
  console.log(`before: target ${JSON.stringify(targetBefore)}`);
  check(STUDENT_TABLES.every((t) => targetBefore[t] > 0), "the target has rows in every student table");
  check(STUDENT_TABLES.every((t) => neighborBefore[t] > 0), "the neighbor has rows in every student table");

  const intruder = await deleteStudent(classId, otherTeacherId, target.id);
  check(intruder.status === "not_found", `another teacher's delete: ${intruder.status}`);
  check(
    JSON.stringify(await studentCounts(target.id)) === JSON.stringify(targetBefore),
    "...and every row of the student is intact",
  );
  const { id: otherClass } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Other class', '4', ${`B${RUN_ID}`.toUpperCase()}) returning id`);
  check(
    (await deleteStudent(otherClass, teacherId, target.id)).status === "already_gone",
    "the owner deleting through a class the student isn't in: a no-op (already_gone)",
  );
  check(
    JSON.stringify(await studentCounts(target.id)) === JSON.stringify(targetBefore),
    "...and every row of the student is still intact",
  );

  const deleted = await deleteStudent(classId, teacherId, target.id);
  check(deleted.status === "deleted", `the owner's delete: ${deleted.status}`);
  const targetAfter = await studentCounts(target.id);
  const neighborAfter = await studentCounts(neighbor.id);
  for (const t of STUDENT_TABLES) {
    check(targetAfter[t] === 0, `${t}: the target's ${targetBefore[t]} rows are gone (now ${targetAfter[t]})`);
    check(neighborAfter[t] === neighborBefore[t], `${t}: the neighbor still has ${neighborBefore[t]} (now ${neighborAfter[t]})`);
  }
  check((await findStudentBySessionToken(target.token)) === null, "the deleted student's session no longer resolves");
  check((await findStudentBySessionToken(neighbor.token))?.student.id === neighbor.id, "the neighbor's session still works");
  check((await deleteStudent(classId, teacherId, target.id)).status === "already_gone", "deleting again: a no-op success (already_gone)");
  check((await deleteStudent(classId, otherTeacherId, target.id)).status === "not_found", "another teacher deleting the gone id: still not_found");
  const neighborStill = await studentCounts(neighbor.id);
  check(JSON.stringify(neighborStill) === JSON.stringify(neighborBefore), "...and the neighbor is still intact");
}

// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id = any(${[`test_abuse_${RUN_ID}`, `test_abuse_other_${RUN_ID}`]}::text[])
    returning id`;
  const attempts = await sql.query(
    "delete from join_attempts where key_hash = any($1::text[]) returning id",
    [[...usedHashes]],
  );
  console.log(
    `\ncleanup: deleted ${rows.length} test teachers (and everything under them), ${attempts.length} join_attempts rows`,
  );
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}`);
  try {
    await setup();
    await checkThrottle();
    await checkProviderFailures();
    await checkJoinCode();
    await checkStudentDelete();
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
  console.error("check-abuse-protection crashed:", error);
  process.exit(1);
});
