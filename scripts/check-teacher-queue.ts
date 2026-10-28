// Checks the teacher's challenge queue, decisions, one more try, and the
// follow-ups through the real neon-http driver and the real app functions,
// with a FAKE effort checker (no model calls; it sleeps a little,
// returns the pass or fail it is told to, and counts its calls):
//
// - Decisions race: --n parallel Accept and Deny calls (mixed, some with
//   one more try) on one challenge make exactly one decision and at most
//   one grant; resolved_by and resolved_at are set.
// - Accept: the student is Passed (by the teacher); submits are refused.
// - Deny: Challenge denied, no answer form, a new note is refused.
// - Deny with one more try after 3 tries: tries allowed = used + 1, checks
//   allowed = used + EXTRA_TRY_CHECKS; exactly one more try is checked;
//   then a new note (round 2), --n parallel sends saving exactly one.
// - --n parallel grants on one challenge: one grant, not double-applied.
// - One more try at the check limit with tries unused: exactly 1 try
//   left; two model failures use the headroom, then the note opens again.
// - Second tab: --n parallel notes while the last allowed check is still
//   running are all "busy" with 0 challenge rows until it finishes; then
//   one note saves (a failing check), or none (a passing one).
// - Auto-close: a passing attempt closes an open challenge in the same
//   transaction, and the queue never lists a passed student.
// - Another teacher can't decide (not_found, still open) or see the queue.
// - The class view's statuses (loadClassStatus) match the student's own
//   (listReadingsWithStatus) and what each case expects.
// - Teacher answers (loadTeacherAnswers): every try's answer per question,
//   pass or not yet, the kept answer, and the latest tip, by student and
//   by reading; another teacher, a wrong class, or another class's
//   student id gets nothing.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-teacher-queue [flags]
//
// Flags:
//   --n=20               parallel calls per burst (default 20)
//   --delay-ms=300       fake checker delay (default 300)
//   --db-concurrency=8   most DB requests in flight (default
//                        DB_CHECK_CONCURRENCY, 8)
//
// Same database guard, connection cap, and NEON_FETCH_ENDPOINT handling as
// every check (scripts/lib/db-check.ts). Writes
// teachers named test_queue_<run> and test_queue_other_<run> and deletes
// them (and everything under them, by cascade) at the end. Never run
// against production.
import { getSql } from "@/db";
import type { EffortCheckInput, EffortVerdict } from "@/lib/ai/effort-check";
import { decideChallenge, loadChallengeQueue, countOpenChallenges, type DecideResult } from "@/lib/challenge-queue";
import { sendChallenge, type ChallengeResult } from "@/lib/challenges";
import { cellKey } from "@/lib/class-status";
import { loadClassStatus } from "@/lib/class-status-db";
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { EXTRA_TRY_CHECKS } from "@/lib/reading-limits";
import { answerStage, type StudentReadingStatus } from "@/lib/reading-progress";
import { listReadingsWithStatus, loadReadingProgress } from "@/lib/reading-progress-db";
import { submitAnswers, type SubmitResult } from "@/lib/submit-answers";
import { answersFor } from "@/lib/teacher-answers";
import { loadTeacherAnswers } from "@/lib/teacher-answers-db";
import { EFFORT_CHECK_LIMIT, type EffortCheckHooks } from "@/lib/submit-answers-core";
import { MAX_TRIES, type AnswerEntry } from "@/lib/validate-answers";
import { prepareDbCheck, throttledExecutor } from "./lib/db-check";
import { openQuestionIds } from "./lib/open-questions";

const { fetchEndpoint, concurrency: DB_CHECK_CONCURRENCY } = prepareDbCheck();

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

const N = intFlag("n", 20);
const DELAY_MS = intFlag("delay-ms", 300);
const DB_CONCURRENCY = intFlag("db-concurrency", DB_CHECK_CONCURRENCY);
const RUN_ID = Math.random().toString(36).slice(2, 10);
const BODY = "Mia walked to the river after the storm and found a fox. ".repeat(10);
const PROMPTS = ["Why did Mia go to the river?", "What did the fox do?", "What do you think, and why?"];

const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

function throttled(limit: number): StatementExecutor {
  return throttledExecutor(neonExecutor, limit);
}
const execute = throttled(DB_CONCURRENCY);

// "error": the model replied, but not usably (counts toward the check
// limit). "outage": it never replied (given back; see
// submit-answers-core.ts).
type Mode = "pass" | "fail" | "error" | "outage";
let modelCalls = 0;
function fakeChecker(mode: Mode, delayMs = DELAY_MS) {
  return async (input: EffortCheckInput, hooks?: EffortCheckHooks): Promise<EffortVerdict[]> => {
    modelCalls++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (mode === "outage") throw new Error("fake model outage");
    if (mode === "error") {
      hooks?.onModelResponse();
      throw new Error("fake unusable reply");
    }
    return input.items.map((item, i) => {
      const pass = mode === "pass" || i < input.items.length - 1;
      return { questionId: item.questionId, pass, nudge: pass ? "" : "Look at the end of the story again." };
    });
  };
}

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

let teacherId = "";
let otherTeacherId = "";
let classId = "";
let readingId = "";
let questionIds: string[] = [];
let studentCount = 0;
// What each student's status on the reading should be at the end.
const expected = new Map<string, StudentReadingStatus>();

async function newStudent(): Promise<string> {
  const i = studentCount++;
  const { id } = await one<{ id: string }>(sql`
    insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
    values (${classId}, ${`Kid${i}`}, 'Q', ${`kid${i} q`}, ${`hash_queue_${RUN_ID}_${i}`})
    returning id`);
  return id;
}

async function setup() {
  ({ id: teacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_queue_${RUN_ID}`}, 'test@example.invalid', 'paid') returning id`));
  ({ id: otherTeacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_queue_other_${RUN_ID}`}, 'other@example.invalid', 'paid') returning id`));
  ({ id: classId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Queue check', '3', ${`QC${RUN_ID}`.toUpperCase().slice(0, 8)}) returning id`));
  ({ id: readingId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Queue check', ${BODY}, ${PROMPTS.length}, 'shared', 'published') returning id`));
  const rows = await sql.query(
    `insert into questions (reading_id, student_id, position, prompt)
     select $1::uuid, null, p.position, p.prompt
     from unnest($2::int[], $3::text[]) as p(position, prompt)
     returning id, position`,
    [readingId, PROMPTS.map((_, i) => i + 1), PROMPTS],
  );
  questionIds = (rows as { id: string; position: number }[]).sort((a, b) => a.position - b.position).map((r) => r.id);
}

function answers(ids = questionIds): AnswerEntry[] {
  return ids.map((questionId) => ({ questionId, value: "Mia went to see the river after the storm." }));
}

// Like the answer form: only the questions that aren't locked yet (passed
// on the latest try).
async function submit(studentId: string, mode: Mode, delayMs?: number): Promise<SubmitResult> {
  const open = await openQuestionIds(execute, studentId, readingId);
  return submitAnswers(studentId, readingId, answers(open), { check: fakeChecker(mode, delayMs), execute });
}

function send(studentId: string, note = "I tried my best."): Promise<ChallengeResult> {
  return sendChallenge(studentId, readingId, note, execute);
}

function decide(challengeId: string, decision: "accept" | "deny", extraTry = false, teacher = teacherId): Promise<DecideResult> {
  return decideChallenge({ challengeId, classId, teacherId: teacher, decision, extraTry }, execute);
}

// A student with 3 failed tries and an open challenge; returns its id.
async function challengedStudent(): Promise<{ student: string; challenge: string }> {
  const student = await newStudent();
  for (let i = 0; i < MAX_TRIES; i++) await submit(student, "fail", 5);
  const sent = await send(student);
  if (sent.status !== "sent") throw new Error(`setup: challenge ${sent.status}`);
  const { id } = await one<{ id: string }>(sql`
    select id from challenges where student_id = ${student} and reading_id = ${readingId} and status = 'open'`);
  return { student, challenge: id };
}

async function row(challengeId: string) {
  return one<{ status: string; resolved_by: string | null; resolved_at: Date | null; tries_allowed: number | null; checks_allowed: number | null; round: number }>(sql`
    select status, resolved_by, resolved_at, tries_allowed, checks_allowed, round from challenges where id = ${challengeId}`);
}

async function counts(studentId: string) {
  return one<{ attempts: number; checks: number; challenges: number; open: number }>(sql`
    select
      (select count(*)::int from attempts where student_id = ${studentId} and reading_id = ${readingId}) as attempts,
      (select count(*)::int from effort_checks where student_id = ${studentId} and reading_id = ${readingId}) as checks,
      (select count(*)::int from challenges where student_id = ${studentId} and reading_id = ${readingId}) as challenges,
      (select count(*)::int from challenges where student_id = ${studentId} and reading_id = ${readingId} and status = 'open') as open`);
}

function tally(settled: PromiseSettledResult<{ status: string }>[]) {
  const statuses: Record<string, number> = {};
  const thrown: string[] = [];
  for (const r of settled) {
    if (r.status === "rejected") thrown.push(String((r.reason as Error)?.message));
    else statuses[r.value.status] = (statuses[r.value.status] ?? 0) + 1;
  }
  return { statuses, thrown };
}

async function studentStatus(studentId: string): Promise<StudentReadingStatus | undefined> {
  return (await listReadingsWithStatus(classId, studentId, execute)).find((r) => r.id === readingId)?.status;
}

async function checkDecisionRace() {
  console.log(`\n== DECISIONS: ${N} parallel Accept/Deny on one challenge ==`);
  const { student, challenge } = await challengedStudent();
  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => decide(challenge, i % 2 ? "deny" : "accept", i % 3 === 0)),
  );
  const { statuses, thrown } = tally(settled as PromiseSettledResult<DecideResult>[]);
  const decided = (statuses.accepted ?? 0) + (statuses.denied ?? 0);
  const r = await row(challenge);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}, row ${r.status}`);
  check(
    decided === 1 && statuses.already_decided === N - 1 && thrown.length === 0,
    `exactly 1 decision, ${N - 1} already decided (got ${decided}/${statuses.already_decided ?? 0}, errors ${thrown.length})`,
  );
  check(
    r.status !== "open" && r.resolved_by === teacherId && r.resolved_at !== null,
    `row decided once: ${r.status}, resolved_by teacher: ${r.resolved_by === teacherId}, resolved_at set: ${r.resolved_at !== null}`,
  );
  const grants = r.tries_allowed === null ? 0 : 1;
  check(
    r.tries_allowed === null || (r.status === "denied" && r.tries_allowed === MAX_TRIES + 1),
    `at most one grant, only on Deny (status ${r.status}, tries allowed ${r.tries_allowed}, grants ${grants})`,
  );
  // Whatever won, the student's status follows it.
  const want: StudentReadingStatus = r.status === "approved" ? "passed" : r.tries_allowed ? "in_progress" : "challenge_denied";
  expected.set(student, want);
}

async function checkAcceptAndDeny() {
  console.log("\n== ACCEPT, DENY ==");
  const accepted = await challengedStudent();
  const a = await decide(accepted.challenge, "accept");
  check(a.status === "accepted", `accept: ${a.status}`);
  const stage = answerStage(await loadReadingProgress(accepted.student, readingId, execute));
  check(stage.kind === "passed" && stage.byTeacher, `accepted, page: ${stage.kind}${stage.kind === "passed" ? `, by teacher ${stage.byTeacher}` : ""}`);
  const before = modelCalls;
  const afterAccept = await submit(accepted.student, "pass");
  check(afterAccept.status === "out_of_tries" && modelCalls === before, `submit after accept: ${afterAccept.status}, no model call`);
  const again = await decide(accepted.challenge, "deny");
  check(again.status === "already_decided", `deny after accept: ${again.status}`);
  expected.set(accepted.student, "passed");

  const denied = await challengedStudent();
  const d = await decide(denied.challenge, "deny");
  check(d.status === "denied" && !d.extraTry, `deny: ${JSON.stringify(d)}`);
  const deniedStage = answerStage(await loadReadingProgress(denied.student, readingId, execute));
  check(deniedStage.kind === "challenged" && deniedStage.status === "denied", `denied, page: ${deniedStage.kind} (no form)`);
  const note = await send(denied.student, "Please look again.");
  check(note.status === "decided" && (await counts(denied.student)).challenges === 1, `new note after a plain deny: ${note.status}`);
  expected.set(denied.student, "challenge_denied");
}

async function checkExtraTry() {
  console.log("\n== DENY WITH ONE MORE TRY, AFTER 3 TRIES ==");
  const { student, challenge } = await challengedStudent();
  const before = await counts(student);
  const d = await decide(challenge, "deny", true);
  const r = await row(challenge);
  check(d.status === "denied" && d.extraTry, `deny with one more try: ${JSON.stringify(d)}`);
  check(
    r.tries_allowed === before.attempts + 1 && r.checks_allowed === before.checks + EXTRA_TRY_CHECKS,
    `limits: tries ${r.tries_allowed} (want ${before.attempts + 1}), checks ${r.checks_allowed} (want ${before.checks + EXTRA_TRY_CHECKS})`,
  );
  let stage = answerStage(await loadReadingProgress(student, readingId, execute));
  check(
    stage.kind === "answer" && stage.extraTry && stage.tryNumber === MAX_TRIES + 1 && stage.maxTries === MAX_TRIES + 1,
    `page: ${stage.kind}, try ${stage.kind === "answer" ? `${stage.tryNumber} of ${stage.maxTries}, extra ${stage.extraTry}` : "-"}`,
  );
  check((await studentStatus(student)) === "in_progress", "status with one more try: in_progress");
  const early = await send(student);
  check(early.status === "not_ready", `note before using the try: ${early.status}`);

  // Parallel submits: exactly one more try is checked.
  const settled = await Promise.allSettled(Array.from({ length: N }, () => submit(student, "fail")));
  const { statuses, thrown } = tally(settled as PromiseSettledResult<SubmitResult>[]);
  const after = await counts(student);
  console.log(`extra try submits ${JSON.stringify(statuses)}, threw ${thrown.length}`);
  check(
    statuses.checked === 1 && after.attempts === MAX_TRIES + 1 && thrown.length === 0,
    `exactly one more try checked: ${statuses.checked ?? 0}, attempts ${after.attempts}`,
  );
  const fifth = await submit(student, "pass");
  check(fifth.status === "out_of_tries", `try ${MAX_TRIES + 2}: ${fifth.status}`);
  stage = answerStage(await loadReadingProgress(student, readingId, execute));
  check(stage.kind === "out_of_tries" && stage.extraTry, `page after the extra try: ${stage.kind}`);

  // A new note: round 2, exactly one under N parallel sends.
  const notes = await Promise.allSettled(Array.from({ length: N }, (_, i) => send(student, `Round two (${i})`)));
  const n = tally(notes as PromiseSettledResult<ChallengeResult>[]);
  const rounds = await sql`
    select round, status from challenges where student_id = ${student} and reading_id = ${readingId} order by round`;
  console.log(`round 2 sends ${JSON.stringify(n.statuses)}, threw ${n.thrown.length}`);
  check(
    n.statuses.sent === 1 && n.statuses.already_sent === N - 1 && rounds.length === 2 && rounds[1].round === 2 && rounds[1].status === "open",
    `round 2: sent ${n.statuses.sent ?? 0}, rows ${rounds.map((x) => `${x.round}:${x.status}`).join(",")}`,
  );
  check((await studentStatus(student)) === "challenged", "status after round 2: challenged");
  const queue = await loadChallengeQueue(classId, teacherId, execute);
  const item = queue.find((q) => q.studentId === student);
  check(
    item !== undefined && item.round === 2 && item.lastTry === MAX_TRIES + 1 && item.triesAllowed === MAX_TRIES + 1 && item.questions.length === PROMPTS.length &&
      item.questions.every((q) => q.answer !== null) && item.questions.at(-1)?.answer?.nudge === "Look at the end of the story again.",
    `queue item: round ${item?.round}, last try ${item?.lastTry}, ${item?.questions.length} answers with results and nudge`,
  );
  expected.set(student, "challenged");
}

async function checkGrantRace() {
  console.log(`\n== ${N} PARALLEL GRANTS ON ONE CHALLENGE ==`);
  const { student, challenge } = await challengedStudent();
  const before = await counts(student);
  const settled = await Promise.allSettled(Array.from({ length: N }, () => decide(challenge, "deny", true)));
  const { statuses, thrown } = tally(settled as PromiseSettledResult<DecideResult>[]);
  const r = await row(challenge);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}`);
  check(
    statuses.denied === 1 && statuses.already_decided === N - 1 && r.tries_allowed === before.attempts + 1 &&
      r.checks_allowed === before.checks + EXTRA_TRY_CHECKS,
    `one grant, not double-applied: tries allowed ${r.tries_allowed} (want ${before.attempts + 1}), checks ${r.checks_allowed} (want ${before.checks + EXTRA_TRY_CHECKS})`,
  );
  expected.set(student, "in_progress");
}

async function checkExtraTryAtCheckLimit() {
  console.log("\n== ONE MORE TRY AT THE CHECK LIMIT, TRIES UNUSED ==");
  const student = await newStudent();
  await submit(student, "fail", 5);
  for (let i = 1; i < EFFORT_CHECK_LIMIT; i++) await submit(student, "error", 5);
  const sent = await send(student);
  const { id } = await one<{ id: string }>(sql`select id from challenges where student_id = ${student} and reading_id = ${readingId}`);
  const d = await decide(id, "deny", true);
  const r = await row(id);
  check(
    sent.status === "sent" && d.status === "denied" && r.tries_allowed === 2 && r.checks_allowed === EFFORT_CHECK_LIMIT + EXTRA_TRY_CHECKS,
    `1 try used, ${EFFORT_CHECK_LIMIT} checks: tries allowed ${r.tries_allowed} (want 2, exactly 1 left), checks ${r.checks_allowed}`,
  );
  // Two model failures use the headroom without using the try.
  const f1 = await submit(student, "error", 5);
  const f2 = await submit(student, "error", 5);
  const f3 = await submit(student, "pass", 5);
  check(
    f1.status === "check_failed" && f2.status === "check_failed" && f3.status === "too_many_checks",
    `headroom: ${f1.status}, ${f2.status}, then ${f3.status}`,
  );
  const stage = answerStage(await loadReadingProgress(student, readingId, execute));
  const again = await send(student, "The checker kept failing.");
  check(stage.kind === "check_limit" && again.status === "sent", `page ${stage.kind}, new note: ${again.status}`);
  expected.set(student, "challenged");
}

async function checkSecondTab() {
  console.log(`\n== SECOND TAB: ${N} notes while the last check runs ==`);
  for (const outcome of ["fail", "pass"] as const) {
    const student = await newStudent();
    for (let i = 0; i < 2; i++) await submit(student, "fail", 5);
    for (let i = 2; i < EFFORT_CHECK_LIMIT - 1; i++) await submit(student, "error", 5);
    const c = await counts(student);
    // The last allowed check, slow. Wait until its claim is counted (not a
    // fixed delay, which a busy machine can outrun), so the notes below
    // all land while it runs.
    const last = submit(student, outcome, 4000);
    let live = await counts(student);
    for (let waited = 0; live.checks < EFFORT_CHECK_LIMIT && waited < 2000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      live = await counts(student);
    }
    const settled = await Promise.allSettled(Array.from({ length: N }, () => send(student, "Please look.")));
    const { statuses, thrown } = tally(settled as PromiseSettledResult<ChallengeResult>[]);
    const during = await counts(student);
    console.log(`${outcome}: checks before ${c.checks}, while running ${live.checks}; notes ${JSON.stringify(statuses)}, threw ${thrown.length}`);
    check(
      statuses.busy === N && during.challenges === 0 && live.checks === EFFORT_CHECK_LIMIT,
      `${outcome}: all ${N} notes busy, 0 challenge rows while the check runs (rows ${during.challenges})`,
    );
    const result = await last;
    const afterNote = await send(student, "Please look.");
    const done = await counts(student);
    if (outcome === "fail") {
      check(
        result.status === "checked" && afterNote.status === "sent" && done.challenges === 1,
        `fail: check ${result.status}, then note ${afterNote.status}, rows ${done.challenges}`,
      );
      expected.set(student, "challenged");
    } else {
      check(
        result.status === "checked" && result.passed && afterNote.status === "already_passed" && done.challenges === 0,
        `pass: check passed, then note ${afterNote.status}, rows ${done.challenges}`,
      );
      expected.set(student, "passed");
    }
  }
}

async function checkAutoClose() {
  console.log("\n== AUTO-CLOSE ON PASS ==");
  // An open challenge with a try left can't be made through the app any
  // more (that's the point); insert one, as a row from before the
  // in-flight block or a stale claim would be.
  const student = await newStudent();
  await submit(student, "fail", 5);
  const { id } = await one<{ id: string }>(sql`
    insert into challenges (student_id, reading_id, note) values (${student}, ${readingId}, 'Old note') returning id`);
  const openBefore = await countOpenChallenges(classId, teacherId, execute);
  const passed = await submit(student, "pass", 5);
  const r = await row(id);
  const openAfter = await countOpenChallenges(classId, teacherId, execute);
  const queue = await loadChallengeQueue(classId, teacherId, execute);
  check(
    passed.status === "checked" && passed.passed && r.status === "closed" && r.resolved_at !== null && r.resolved_by === null,
    `pass closes it: ${r.status}, resolved_at set ${r.resolved_at !== null}, resolved_by ${r.resolved_by}`,
  );
  check(openAfter === openBefore - 1 && !queue.some((q) => q.id === id), `queue count ${openBefore} -> ${openAfter}, not listed`);
  const late = await decide(id, "accept");
  check(late.status === "already_decided", `deciding it now: ${late.status}`);
  expected.set(student, "passed");

  // Defense in depth: an open row for a student who passed is filtered.
  const passedStudent = await newStudent();
  await submit(passedStudent, "pass", 5);
  const { id: stray } = await one<{ id: string }>(sql`
    insert into challenges (student_id, reading_id, note) values (${passedStudent}, ${readingId}, 'Stray') returning id`);
  const listed = (await loadChallengeQueue(classId, teacherId, execute)).some((q) => q.id === stray);
  const strayDecide = await decide(stray, "deny", true);
  const strayRow = await row(stray);
  check(!listed && strayDecide.status === "already_decided" && strayRow.status === "open" && strayRow.tries_allowed === null,
    `open row for a passed student: listed ${listed}, decide ${strayDecide.status}, no grant`);
  expected.set(passedStudent, "passed");
}

async function checkOwnership() {
  console.log("\n== ANOTHER TEACHER ==");
  const { student, challenge } = await challengedStudent();
  const results = await Promise.all([
    decide(challenge, "accept", false, otherTeacherId),
    decide(challenge, "deny", true, otherTeacherId),
  ]);
  const r = await row(challenge);
  check(results.every((x) => x.status === "not_found") && r.status === "open" && r.tries_allowed === null,
    `other teacher: ${results.map((x) => x.status).join(", ")}, row still ${r.status}`);
  const theirQueue = await loadChallengeQueue(classId, otherTeacherId, execute);
  const theirCount = await countOpenChallenges(classId, otherTeacherId, execute);
  const theirStatus = await loadClassStatus(classId, otherTeacherId, execute);
  check(theirQueue.length === 0 && theirCount === 0 && theirStatus.students.length === 0 && theirStatus.readings.length === 0,
    `other teacher sees nothing: queue ${theirQueue.length}, count ${theirCount}, students ${theirStatus.students.length}`);
  const wrongClass = await decideChallenge({ challengeId: challenge, classId: crypto.randomUUID(), teacherId, decision: "accept", extraTry: false }, execute);
  check(wrongClass.status === "not_found" && (await row(challenge)).status === "open", `right teacher, wrong class: ${wrongClass.status}`);
  expected.set(student, "challenged");
}

async function checkTeacherAnswers() {
  console.log("\n== TEACHER ANSWERS: per try, owner scoped ==");
  const student = await newStudent();
  // Try 1: q1 and q2 pass, q3 not yet; try 2 sends only q3, not yet again.
  await submit(student, "fail", 5);
  await submit(student, "fail", 5);
  const byStudent = answersFor(await loadTeacherAnswers(classId, teacherId, { studentId: student }, execute), student, readingId);
  const [q1, , q3] = byStudent;
  check(
    byStudent.length === PROMPTS.length && byStudent.every((q, i) => q.prompt === PROMPTS[i]),
    `by student: ${byStudent.length} questions in order`,
  );
  check(
    JSON.stringify(q1?.tries.map((t) => [t.tryNumber, t.pass, t.keptFrom])) === JSON.stringify([[1, true, null], [2, true, 1]]),
    `q1 passed on try 1, kept on try 2: ${JSON.stringify(q1?.tries.map((t) => [t.tryNumber, t.pass, t.keptFrom]))}`,
  );
  check(
    JSON.stringify(q3?.tries.map((t) => [t.tryNumber, t.pass])) === JSON.stringify([[1, false], [2, false]]) &&
      q3?.tries.every((t) => t.text === answers()[0].value) === true &&
      q3?.latestTip?.tryNumber === 2 && q3.latestTip.text === "Look at the end of the story again.",
    `q3 not yet on tries 1 and 2, latest tip from try ${q3?.latestTip?.tryNumber}`,
  );
  const byReading = await loadTeacherAnswers(classId, teacherId, { readingId }, execute);
  check(
    JSON.stringify(answersFor(byReading, student, readingId)) === JSON.stringify(byStudent),
    "by reading: the same answers for this student",
  );

  // Another teacher's class, reading, and student with a saved try.
  const { id: theirClass } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${otherTeacherId}, 'Other class', '3', ${`QO${RUN_ID}`.toUpperCase().slice(0, 8)}) returning id`);
  const { id: theirReading } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${theirClass}, 'Other reading', ${BODY}, 1, 'shared', 'published') returning id`);
  const { id: theirQuestion } = await one<{ id: string }>(sql`
    insert into questions (reading_id, student_id, position, prompt) values (${theirReading}, null, 1, 'Why?') returning id`);
  const { id: theirStudent } = await one<{ id: string }>(sql`
    insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
    values (${theirClass}, 'Other', 'K', 'other k', ${`hash_queue_${RUN_ID}_other`}) returning id`);
  const { id: theirAttempt } = await one<{ id: string }>(sql`
    insert into attempts (student_id, reading_id, try_number, result) values (${theirStudent}, ${theirReading}, 1, 'fail') returning id`);
  await sql`insert into answers (attempt_id, question_id, text, ai_pass, ai_feedback)
    values (${theirAttempt}, ${theirQuestion}, 'Because.', false, 'Say more.')`;

  const leaks = {
    otherTeacherOurClass: Object.keys(await loadTeacherAnswers(classId, otherTeacherId, { studentId: student }, execute)).length,
    otherTeacherOurReading: Object.keys(await loadTeacherAnswers(classId, otherTeacherId, { readingId }, execute)).length,
    usTheirClass: Object.keys(await loadTeacherAnswers(theirClass, teacherId, {}, execute)).length,
    usTheirStudent: Object.keys(await loadTeacherAnswers(classId, teacherId, { studentId: theirStudent }, execute)).length,
    usTheirReading: Object.keys(await loadTeacherAnswers(classId, teacherId, { readingId: theirReading }, execute)).length,
    wrongClass: Object.keys(await loadTeacherAnswers(crypto.randomUUID(), teacherId, { studentId: student }, execute)).length,
    malformed: Object.keys(await loadTeacherAnswers("not-a-uuid", teacherId, {}, execute)).length,
  };
  check(Object.values(leaks).every((n) => n === 0), `nothing across teachers or classes: ${JSON.stringify(leaks)}`);
  const theirs = answersFor(await loadTeacherAnswers(theirClass, otherTeacherId, {}, execute), theirStudent, theirReading);
  check(theirs.length === 1 && theirs[0].tries[0]?.text === "Because.", "the other teacher sees their own student's answer");
  await sql`delete from classes where id = ${theirClass}`;
  // 2 of 3 tries used.
  expected.set(student, "in_progress");
}

async function checkStatusDerivation() {
  console.log("\n== STATUS: class view vs student view vs expected ==");
  const notStarted = await newStudent();
  expected.set(notStarted, "not_started");
  // Every try failed, no note yet: Waiting on both sides (F3).
  const outOfTries = await newStudent();
  for (let i = 0; i < MAX_TRIES; i++) await submit(outOfTries, "fail", 5);
  expected.set(outOfTries, "waiting");
  const status = await loadClassStatus(classId, teacherId, execute);
  let mismatches = 0;
  for (const [student, want] of expected) {
    const teacherSees = status.cells[cellKey(student, readingId)]?.status ?? "not_started";
    const studentSees = await studentStatus(student);
    if (teacherSees !== want || studentSees !== want) {
      mismatches++;
      console.log(`  mismatch: want ${want}, teacher ${teacherSees}, student ${studentSees}`);
    }
  }
  const counted: Record<string, number> = {};
  for (const want of expected.values()) counted[want] = (counted[want] ?? 0) + 1;
  check(
    mismatches === 0 && status.students.length === expected.size,
    `${expected.size} students, ${mismatches} mismatches (${JSON.stringify(counted)})`,
  );
}

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id in (${`test_queue_${RUN_ID}`}, ${`test_queue_other_${RUN_ID}`}) returning id`;
  const left = await one<{ n: number }>(sql`
    select (select count(*) from students where session_token_hash like ${`hash_queue_${RUN_ID}_%`})::int as n`);
  console.log(`\ncleanup: deleted ${rows.length} test teachers (and everything under them, by cascade); students left: ${left.n}`);
  if (left.n !== 0) failures.push(`cleanup left ${left.n} students`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}, db concurrency ${DB_CONCURRENCY}`);
  try {
    await setup();
    await checkDecisionRace();
    await checkAcceptAndDeny();
    await checkExtraTry();
    await checkGrantRace();
    await checkExtraTryAtCheckLimit();
    await checkSecondTab();
    await checkAutoClose();
    await checkOwnership();
    await checkTeacherAnswers();
    await checkStatusDerivation();
  } finally {
    await cleanup();
  }
  console.log(`\nfake model calls: ${modelCalls}`);
  if (failures.length) {
    console.log(`\nFAIL\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((error) => {
  console.error("check-teacher-queue crashed:", error);
  process.exit(1);
});
