// Checks answering, the effort-check guards, and challenges through the real
// neon-http driver and the real app functions, with a FAKE effort checker
// (no model calls; it sleeps a little, returns the pass or fail it is
// told to, and counts its calls):
//
// - Normal flow: a failing try, then a passing one; then nothing more is
//   checked ("already_passed"). Attempts, answers, nudges, and effort_checks
//   rows are what they should be; the status is Passed.
// - Race: --n parallel submits for one student and reading, in --waves
//   waves, never make more than 3 attempts or EFFORT_CHECK_LIMIT checks,
//   and the model is called exactly once per effort_checks row. While one
//   check is live, the others get "busy".
// - After 3 failed tries, try 4 is refused ("out_of_tries").
// - A model failure leaves the try unused but counts toward the limit;
//   at the limit the next submit is "too_many_checks" with no model call.
// - A stale claim stops blocking; a fresh one blocks ("busy").
// - Refused with no claim and no model call: a student from another class,
//   a reading in another class, an unpublished reading, and wrong question
//   ids (missing, extra, doubled).
// - Challenges: refused before 3 failed tries; --n parallel sends after 3
//   make exactly 1 row (the rest "already_sent"); the status is Challenged.
// - The check limit opens the challenge with tries left: a student with 0
//   tries and EFFORT_CHECK_LIMIT model failures sees the check_limit page
//   (no answer form), is In progress, and --n parallel sends make exactly
//   1 row; a student with 1 try and the limit used can send too; a student
//   with 1 try and one check under the limit is refused ("not_ready").
// - Passed answers are locked: q1 passes on try 1; try 2 sends only q2
//   and q3 to the checker; a crafted form that still has q1 is "stale"
//   with no claim and no model call; a crafted commit straight to the
//   store can't replace q1 either (the SQL keeps it); a given-back check
//   in between leaves the lock and the try; the reading passes on try 2
//   with q1 carried over as it was; 2 counted checks, 2 model calls. A
//   student out of tries with q1 locked can still send the note, and the
//   teacher's queue shows every answer of the last try.
//
// Every submit here sends only the questions that aren't locked yet, as
// the answer form does.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-student-answers [flags]
//
// Flags:
//   --n=20               parallel submits or sends per burst (default 20)
//   --waves=5            race waves (default 5, at least 3)
//   --delay-ms=300       fake checker delay (default 300)
//   --db-concurrency=8   most DB requests in flight (default
//                        DB_CHECK_CONCURRENCY, 8), so a local Postgres
//                        isn't flooded.
//
// Same database guard, connection cap, and NEON_FETCH_ENDPOINT handling as
// every check (scripts/lib/db-check.ts). Writes a
// teacher named test_answers_<run> and deletes it (and everything under it,
// by cascade) at the end. Never run against production.
import { getSql } from "@/db";
import type { EffortCheckInput, EffortVerdict } from "@/lib/ai/effort-check";
import { sendChallenge, type ChallengeResult } from "@/lib/challenges";
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { answerStage } from "@/lib/reading-progress";
import { doneLabel } from "@/lib/done-count";
import { listReadingsWithStatus, loadReadingProgress } from "@/lib/reading-progress-db";
import { queueItems, queueStatements } from "@/lib/challenge-queue-core";
import { submitAnswers, type SubmitResult } from "@/lib/submit-answers";
import {
  EFFORT_CHECK_LIMIT,
  EFFORT_CLAIM_STALE_SECONDS,
  EFFORT_GIVEN_BACK_WINDOW_LIMIT,
  EFFORT_GIVEN_BACK_WINDOW_MINUTES,
  postgresAttemptStore,
  type EffortCheckHooks,
} from "@/lib/submit-answers-core";
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
// At least MAX_TRIES waves, so the race student ends out of tries (the
// challenge check needs one).
const WAVES = Math.max(intFlag("waves", 5), MAX_TRIES);
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

// The fake effort checker. "pass" passes every answer; "fail" fails the
// last one with a nudge; "first" passes only the first one.
// "error": the model replied, but not usably (counts toward the check
// limit). "outage": it never replied (given back; see
// submit-answers-core.ts). "timeout": it never replied before the deadline
// (given back, reported as timed_out).
type Mode = "pass" | "fail" | "first" | "error" | "outage" | "timeout";
let modelCalls = 0;
// The question ids of the last check, in order.
let lastChecked: string[] = [];
function fakeChecker(mode: Mode, delayMs = DELAY_MS) {
  return async (input: EffortCheckInput, hooks?: EffortCheckHooks): Promise<EffortVerdict[]> => {
    modelCalls++;
    lastChecked = input.items.map((item) => item.questionId);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (mode === "outage") throw new Error("fake model outage");
    if (mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (mode === "error") {
      hooks?.onModelResponse();
      throw new Error("fake unusable reply");
    }
    return input.items.map((item, i) => {
      const pass = mode === "first" ? i === 0 : mode === "pass" || i < input.items.length - 1;
      return { questionId: item.questionId, pass, nudge: pass ? "" : "Look at the end of the story again." };
    });
  };
}

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

let teacherId = "";
let classId = "";
let otherClassId = "";
let readingId = "";
let draftId = "";
let otherReadingId = "";
let questionIds: string[] = [];
let studentCount = 0;

async function newStudent(inClass = classId): Promise<string> {
  const i = studentCount++;
  const { id } = await one<{ id: string }>(sql`
    insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
    values (${inClass}, ${`Kid${i}`}, 'Q', ${`kid${i} q`}, ${`hash_answers_${RUN_ID}_${i}`})
    returning id`);
  return id;
}

async function addReading(inClass: string, title: string, status: string): Promise<{ id: string; questions: string[] }> {
  const { id } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${inClass}, ${title}, ${BODY}, ${PROMPTS.length}, 'shared', ${status}::reading_status)
    returning id`);
  const rows = await sql.query(
    `insert into questions (reading_id, student_id, position, prompt)
     select $1::uuid, null, p.position, p.prompt
     from unnest($2::int[], $3::text[]) as p(position, prompt)
     returning id, position`,
    [id, PROMPTS.map((_, i) => i + 1), PROMPTS],
  );
  const questions = (rows as { id: string; position: number }[]).sort((a, b) => a.position - b.position).map((r) => r.id);
  return { id, questions };
}

async function setup() {
  ({ id: teacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_answers_${RUN_ID}`}, 'test@example.invalid', 'paid')
    returning id`));
  ({ id: classId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Answers check', '3', ${`AC${RUN_ID}`.toUpperCase().slice(0, 8)})
    returning id`));
  ({ id: otherClassId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Other class', '3', ${`AO${RUN_ID}`.toUpperCase().slice(0, 8)})
    returning id`));
  const main = await addReading(classId, "Answers check", "published");
  readingId = main.id;
  questionIds = main.questions;
  draftId = (await addReading(classId, "Draft", "draft")).id;
  otherReadingId = (await addReading(otherClassId, "Other class reading", "published")).id;
}

function answers(ids = questionIds, text = "Mia went to see the river after the storm."): AnswerEntry[] {
  return ids.map((questionId) => ({ questionId, value: text }));
}

async function submit(studentId: string, mode: Mode, opts: { reading?: string; entries?: AnswerEntry[]; delayMs?: number } = {}) {
  const reading = opts.reading ?? readingId;
  const entries = opts.entries ?? (reading === readingId ? answers(await openQuestionIds(execute, studentId, readingId)) : answers());
  return submitAnswers(studentId, reading, entries, {
    check: fakeChecker(mode, opts.delayMs),
    execute,
  });
}

async function counts(studentId: string, reading = readingId) {
  return one<{ attempts: number; answers: number; checks: number; live: number; challenges: number }>(sql`
    select
      (select count(*)::int from attempts where student_id = ${studentId} and reading_id = ${reading}) as attempts,
      (select count(*)::int from answers an join attempts a on a.id = an.attempt_id
        where a.student_id = ${studentId} and a.reading_id = ${reading}) as answers,
      (select count(*)::int from effort_checks where student_id = ${studentId} and reading_id = ${reading}) as checks,
      (select count(*)::int from effort_checks
        where student_id = ${studentId} and reading_id = ${reading} and finished_at is null) as live,
      (select count(*)::int from challenges where student_id = ${studentId} and reading_id = ${reading}) as challenges`);
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

async function statusOf(studentId: string): Promise<string | undefined> {
  return (await listReadingsWithStatus(classId, studentId, execute)).find((r) => r.id === readingId)?.status;
}

async function checkNormalFlow() {
  console.log("\n== NORMAL FLOW: fail, then pass ==");
  const student = await newStudent();
  check((await statusOf(student)) === "not_started", "status before any try: not_started");
  const calls = modelCalls;
  const first = await submit(student, "fail");
  check(first.status === "checked" && !first.passed && first.tryNumber === 1, `try 1: ${JSON.stringify(first.status === "checked" ? { passed: first.passed, try: first.tryNumber } : first)}`);
  check((await statusOf(student)) === "in_progress", "status after a failed try: in_progress");
  // The class list's "X of Y done": the fake fails only the last answer.
  const row = (await listReadingsWithStatus(classId, student, execute)).find((r) => r.id === readingId);
  check(
    row?.passedAnswers === 2 && doneLabel(row.passedAnswers, row.questionCount) === "2 of 3 done",
    `class list after try 1: ${row ? doneLabel(row.passedAnswers, row.questionCount) : "missing"}`,
  );
  const progress = await loadReadingProgress(student, readingId, execute);
  const stage = answerStage(progress);
  const nudge = progress.attempts[0]?.answers[questionIds[2]]?.nudge;
  check(
    stage.kind === "answer" && stage.tryNumber === 2 && nudge === "Look at the end of the story again.",
    `page after try 1: ${stage.kind}, try ${stage.kind === "answer" ? stage.tryNumber : "-"}, nudge saved: ${Boolean(nudge)}`,
  );
  const second = await submit(student, "pass");
  check(second.status === "checked" && second.passed && second.tryNumber === 2, `try 2: ${second.status}`);
  check(lastChecked.join(",") === questionIds[2], `try 2 checked only the question that wasn't passed (${lastChecked.length} of 3)`);
  const third = await submit(student, "pass");
  check(third.status === "already_passed", `after the pass: ${third.status}`);
  const c = await counts(student);
  check(
    c.attempts === 2 && c.answers === 6 && c.checks === 2 && c.live === 0 && modelCalls - calls === 2,
    `rows: attempts ${c.attempts}, answers ${c.answers}, checks ${c.checks}, live ${c.live}, model calls ${modelCalls - calls} (want 2/6/2/0/2)`,
  );
  const challenge = await sendChallenge(student, readingId, "Please look.", execute);
  check(challenge.status === "already_passed", `challenge after a pass: ${challenge.status}`);
  check((await statusOf(student)) === "passed", "status: passed");
  const passedStage = answerStage(await loadReadingProgress(student, readingId, execute));
  check(passedStage.kind === "passed" && passedStage.attempt?.tryNumber === 2, `page: ${passedStage.kind} showing try 2`);
}

async function checkRace(): Promise<string> {
  console.log(`\n== RACE: ${WAVES} waves x ${N} parallel submits, failing checker ==`);
  const student = await newStudent();
  const calls = modelCalls;
  let busyWhileLive = true;
  for (let wave = 1; wave <= WAVES; wave++) {
    const settled = await Promise.allSettled(Array.from({ length: N }, () => submit(student, "fail")));
    const { statuses, thrown } = tally(settled as PromiseSettledResult<SubmitResult>[]);
    console.log(`wave ${wave}: ${JSON.stringify(statuses)}, threw ${thrown.length}`);
    if (thrown.length) check(false, `wave ${wave} threw: ${[...new Set(thrown)].join("; ").slice(0, 300)}`);
    if (wave === 1) busyWhileLive = statuses.checked === 1 && statuses.busy === N - 1;
  }
  check(busyWhileLive, `wave 1: exactly 1 checked and ${N - 1} busy (one live claim at a time)`);
  const c = await counts(student);
  check(
    c.attempts === MAX_TRIES && c.checks <= EFFORT_CHECK_LIMIT && c.live === 0 && modelCalls - calls === c.checks,
    `attempts ${c.attempts} (want ${MAX_TRIES}), checks ${c.checks} (max ${EFFORT_CHECK_LIMIT}), live ${c.live}, model calls ${modelCalls - calls} (= checks)`,
  );
  const tries = await sql`
    select try_number from attempts where student_id = ${student} and reading_id = ${readingId} order by try_number`;
  check(tries.map((t) => t.try_number).join(",") === "1,2,3", `try numbers ${tries.map((t) => t.try_number).join(",")}`);
  const before = modelCalls;
  const fourth = await submit(student, "pass");
  check(fourth.status === "out_of_tries" && modelCalls === before, `try 4: ${fourth.status}, no model call`);

  console.log(`\n== FAST RACE: ${N} parallel submits, quick checker ==`);
  const quick = await newStudent();
  const quickCalls = modelCalls;
  const settled = await Promise.allSettled(Array.from({ length: N }, () => submit(quick, "fail", { delayMs: 5 })));
  const { statuses, thrown } = tally(settled as PromiseSettledResult<SubmitResult>[]);
  const q = await counts(quick);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}`);
  check(
    thrown.length === 0 && (statuses.checked ?? 0) <= MAX_TRIES && q.attempts <= MAX_TRIES &&
      q.checks <= EFFORT_CHECK_LIMIT && modelCalls - quickCalls === q.checks,
    `checked ${statuses.checked ?? 0}, attempts ${q.attempts} (max ${MAX_TRIES}), checks ${q.checks} (max ${EFFORT_CHECK_LIMIT}), model calls ${modelCalls - quickCalls}`,
  );
  return student;
}

async function checkModelFailureAndLimit() {
  console.log("\n== MODEL FAILURE AND THE CHECK LIMIT ==");
  const student = await newStudent();
  const failed = await submit(student, "error", { delayMs: 20 });
  let c = await counts(student);
  check(failed.status === "check_failed" && c.attempts === 0 && c.checks === 1 && c.live === 0, `model failure: ${failed.status}, attempts ${c.attempts}, checks ${c.checks}, live ${c.live}`);
  const outcome = await one<{ outcome: string }>(sql`
    select outcome from effort_checks where student_id = ${student} and reading_id = ${readingId}`);
  check(outcome.outcome === "error", `failed check outcome: ${outcome.outcome}`);
  const next = await submit(student, "fail", { delayMs: 20 });
  check(next.status === "checked" && next.tryNumber === 1, `next submit uses try 1: ${next.status}`);

  const slow = await newStudent();
  const timedOut = await submit(slow, "timeout", { delayMs: 20 });
  c = await counts(slow);
  const slowOutcome = await one<{ outcome: string }>(sql`
    select outcome from effort_checks where student_id = ${slow} and reading_id = ${readingId}`);
  check(
    timedOut.status === "timed_out" && c.attempts === 0 && c.live === 0 && slowOutcome.outcome === "given_back",
    `timeout: ${timedOut.status}, attempts ${c.attempts}, live ${c.live}, outcome ${slowOutcome.outcome}`,
  );
  const afterTimeout = await submit(slow, "fail", { delayMs: 20 });
  check(afterTimeout.status === "checked" && afterTimeout.tryNumber === 1, `after a timeout, the next submit uses try 1: ${afterTimeout.status}`);

  const limited = await newStudent();
  for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) await submit(limited, "error", { delayMs: 5 });
  const before = modelCalls;
  const refused = await submit(limited, "pass");
  c = await counts(limited);
  check(
    refused.status === "too_many_checks" && modelCalls === before && c.checks === EFFORT_CHECK_LIMIT && c.attempts === 0,
    `after ${EFFORT_CHECK_LIMIT} failed checks: ${refused.status}, no model call, checks ${c.checks}`,
  );
}

// A check that fails with no model reply (not set up, out of credits, an
// outage, a timeout) is given back: it never counts toward the limit, and
// only a short window pauses checking during an outage.
async function checkGivenBack() {
  console.log("\n== GIVEN-BACK CHECKS (NO MODEL REPLY) ==");
  const student = await newStudent();
  for (let i = 0; i < EFFORT_GIVEN_BACK_WINDOW_LIMIT; i++) {
    const r = await submit(student, "outage", { delayMs: 5 });
    check(r.status === "check_failed", `outage ${i + 1}: ${r.status}`);
  }
  const rows = (await sql`
    select outcome from effort_checks where student_id = ${student} and reading_id = ${readingId}`) as { outcome: string }[];
  check(
    rows.length === EFFORT_GIVEN_BACK_WINDOW_LIMIT && rows.every((r) => r.outcome === "given_back"),
    `every outage check is marked given_back (${rows.map((r) => r.outcome).join(", ")})`,
  );
  const before = modelCalls;
  const paused = await submit(student, "pass");
  const minutes = paused.status === "paused" && paused.retryAt ? (paused.retryAt.getTime() - Date.now()) / 60_000 : NaN;
  check(
    paused.status === "paused" && modelCalls === before && minutes > EFFORT_GIVEN_BACK_WINDOW_MINUTES - 1 && minutes <= EFFORT_GIVEN_BACK_WINDOW_MINUTES,
    `the ${EFFORT_GIVEN_BACK_WINDOW_LIMIT + 1}th submit in the window is paused, no model call, frees up in ${minutes.toFixed(1)} min`,
  );
  const stage = answerStage(await loadReadingProgress(student, readingId));
  check(stage.kind === "answer", `given-back checks never move the student toward the note to the teacher: ${stage.kind}`);

  // Past the window, more outages: still never the check limit.
  for (let round = 0; round < 3; round++) {
    await sql`update effort_checks set created_at = created_at - make_interval(mins => ${EFFORT_GIVEN_BACK_WINDOW_MINUTES + 1})
      where student_id = ${student} and reading_id = ${readingId}`;
    for (let i = 0; i < EFFORT_GIVEN_BACK_WINDOW_LIMIT; i++) await submit(student, "outage", { delayMs: 5 });
  }
  await sql`update effort_checks set created_at = created_at - make_interval(mins => ${EFFORT_GIVEN_BACK_WINDOW_MINUTES + 1})
    where student_id = ${student} and reading_id = ${readingId}`;
  const total = await one<{ n: number; counted: number }>(sql`
    select count(*)::int as n, count(*) filter (where outcome is distinct from 'given_back')::int as counted
    from effort_checks where student_id = ${student} and reading_id = ${readingId}`);
  const after = await submit(student, "fail", { delayMs: 5 });
  check(
    total.n === 4 * EFFORT_GIVEN_BACK_WINDOW_LIMIT && total.counted === 0 && after.status === "checked" && after.tryNumber === 1,
    `${total.n} given-back checks (more than the limit of ${EFFORT_CHECK_LIMIT}), ${total.counted} counted, and the next real check is try 1: ${after.status}`,
  );

  // A burst during an outage: one check at a time, never past the window.
  const burst = await newStudent();
  const callsBefore = modelCalls;
  for (let wave = 0; wave < 3; wave++) {
    await Promise.allSettled(Array.from({ length: 10 }, () => submit(burst, "outage", { delayMs: 5 })));
  }
  const burstRows = await one<{ n: number }>(sql`
    select count(*)::int as n from effort_checks where student_id = ${burst} and reading_id = ${readingId}`);
  check(
    burstRows.n === EFFORT_GIVEN_BACK_WINDOW_LIMIT && modelCalls - callsBefore === EFFORT_GIVEN_BACK_WINDOW_LIMIT,
    `30 outage submits in 3 waves: ${burstRows.n} checks and ${modelCalls - callsBefore} model calls (max ${EFFORT_GIVEN_BACK_WINDOW_LIMIT})`,
  );
}

async function checkStaleClaim() {
  console.log("\n== STALE AND LIVE CLAIMS ==");
  const student = await newStudent();
  await sql`
    insert into effort_checks (student_id, reading_id, created_at)
    values (${student}, ${readingId}, now() - make_interval(secs => ${EFFORT_CLAIM_STALE_SECONDS + 5}))`;
  const afterStale = await submit(student, "fail", { delayMs: 5 });
  check(afterStale.status === "checked", `stale claim doesn't block: ${afterStale.status}`);
  await sql`insert into effort_checks (student_id, reading_id) values (${student}, ${readingId})`;
  const before = modelCalls;
  const busy = await submit(student, "pass");
  check(busy.status === "busy" && modelCalls === before, `fresh unfinished claim: ${busy.status}, no model call`);
}

async function checkRefusals() {
  console.log("\n== REFUSALS ==");
  const student = await newStudent();
  const outsider = await newStudent(otherClassId);
  const before = modelCalls;
  const cases: [string, Promise<SubmitResult>, string][] = [
    ["student from another class", submit(outsider, "pass"), "not_found"],
    ["reading in another class", submit(student, "pass", { reading: otherReadingId }), "not_found"],
    ["unpublished reading", submit(student, "pass", { reading: draftId }), "not_found"],
    ["malformed reading id", submit(student, "pass", { reading: "not-a-uuid" }), "not_found"],
    ["a question missing", submit(student, "pass", { entries: answers(questionIds.slice(0, 2)) }), "stale"],
    ["an extra question", submit(student, "pass", { entries: answers([...questionIds, crypto.randomUUID()]) }), "stale"],
    ["another reading's questions", submit(student, "pass", { entries: answers([questionIds[0], questionIds[1], crypto.randomUUID()]) }), "stale"],
    ["a doubled question", submit(student, "pass", { entries: [...answers(), answers()[0]] }), "stale"],
    ["a blank answer", submit(student, "pass", { entries: [...answers(questionIds.slice(0, 2)), { questionId: questionIds[2], value: "  " }] }), "invalid"],
  ];
  for (const [label, promise, want] of cases) {
    const result = await promise;
    check(result.status === want, `${label}: ${result.status} (want ${want})`);
  }
  const c = await counts(student);
  const o = await counts(outsider);
  check(modelCalls === before && c.checks === 0 && o.checks === 0, `no claims, no model calls (calls ${modelCalls - before}, checks ${c.checks + o.checks})`);
}

async function checkChallenges(outOfTries: string) {
  console.log(`\n== CHALLENGES: ${N} parallel sends ==`);
  check((await statusOf(outOfTries)) === "waiting", "every try failed, no note yet: status waiting (Send your teacher a note)");
  const early = await newStudent();
  await submit(early, "fail", { delayMs: 5 });
  const tooEarly = await sendChallenge(early, readingId, "Please look.", execute);
  check(tooEarly.status === "not_ready" && (await counts(early)).challenges === 0, `after 1 failed try: ${tooEarly.status}`);
  const blank = await sendChallenge(outOfTries, readingId, "   ", execute);
  check(blank.status === "invalid", `blank note: ${blank.status}`);
  const outsider = await newStudent(otherClassId);
  const other = await sendChallenge(outsider, readingId, "Please look.", execute);
  check(other.status === "not_found", `student from another class: ${other.status}`);

  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => sendChallenge(outOfTries, readingId, `I tried my best. (${i})`, execute)),
  );
  const { statuses, thrown } = tally(settled as PromiseSettledResult<ChallengeResult>[]);
  const c = await counts(outOfTries);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}, rows ${c.challenges}`);
  check(
    statuses.sent === 1 && statuses.already_sent === N - 1 && thrown.length === 0 && c.challenges === 1,
    `sent ${statuses.sent ?? 0}, already_sent ${statuses.already_sent ?? 0}, errors ${thrown.length}, rows ${c.challenges} (want 1/${N - 1}/0/1)` +
      (thrown.length ? `: ${[...new Set(thrown)].join("; ").slice(0, 300)}` : ""),
  );
  const row = await one<{ status: string }>(sql`
    select status from challenges where student_id = ${outOfTries} and reading_id = ${readingId}`);
  check(row.status === "open", `challenge status: ${row.status}`);
  check((await statusOf(outOfTries)) === "challenged", "reading status: challenged");
}

async function checkCheckLimit() {
  console.log(`\n== CHECK LIMIT OPENS THE CHALLENGE: ${N} parallel sends ==`);
  // 0 tries, every check a model failure.
  const none = await newStudent();
  for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) await submit(none, "error", { delayMs: 5 });
  let c = await counts(none);
  check(c.attempts === 0 && c.checks === EFFORT_CHECK_LIMIT, `0 tries: attempts ${c.attempts}, checks ${c.checks}`);
  let stage = answerStage(await loadReadingProgress(none, readingId, execute));
  check(stage.kind === "check_limit" && stage.attempt === null, `0 tries at the limit, page: ${stage.kind}`);
  check((await statusOf(none)) === "waiting", "0 tries at the limit, status: waiting (Send your teacher a note)");
  const refused = await submit(none, "pass");
  check(refused.status === "too_many_checks", `0 tries at the limit, submit: ${refused.status}`);
  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => sendChallenge(none, readingId, `The checker kept failing. (${i})`, execute)),
  );
  const { statuses, thrown } = tally(settled as PromiseSettledResult<ChallengeResult>[]);
  c = await counts(none);
  console.log(`results ${JSON.stringify(statuses)}, threw ${thrown.length}, rows ${c.challenges}`);
  check(
    statuses.sent === 1 && statuses.already_sent === N - 1 && thrown.length === 0 && c.challenges === 1,
    `sent ${statuses.sent ?? 0}, already_sent ${statuses.already_sent ?? 0}, errors ${thrown.length}, rows ${c.challenges} (want 1/${N - 1}/0/1)` +
      (thrown.length ? `: ${[...new Set(thrown)].join("; ").slice(0, 300)}` : ""),
  );
  stage = answerStage(await loadReadingProgress(none, readingId, execute));
  check(stage.kind === "challenged" && stage.status === "open", `after the note, page: ${stage.kind}`);
  check((await statusOf(none)) === "challenged", "after the note, status: challenged");

  // 1 failed try, then model failures up to the limit.
  const one = await newStudent();
  await submit(one, "fail", { delayMs: 5 });
  for (let i = 1; i < EFFORT_CHECK_LIMIT; i++) await submit(one, "error", { delayMs: 5 });
  c = await counts(one);
  stage = answerStage(await loadReadingProgress(one, readingId, execute));
  check(
    c.attempts === 1 && c.checks === EFFORT_CHECK_LIMIT && stage.kind === "check_limit" && stage.attempt?.tryNumber === 1,
    `1 try at the limit: attempts ${c.attempts}, checks ${c.checks}, page ${stage.kind} showing try ${stage.kind === "check_limit" ? stage.attempt?.tryNumber : "-"}`,
  );
  const sent = await sendChallenge(one, readingId, "Please look.", execute);
  check(sent.status === "sent" && (await counts(one)).challenges === 1, `1 try at the limit, send: ${sent.status}`);

  // 1 failed try, one check under the limit.
  const under = await newStudent();
  await submit(under, "fail", { delayMs: 5 });
  for (let i = 2; i < EFFORT_CHECK_LIMIT; i++) await submit(under, "error", { delayMs: 5 });
  c = await counts(under);
  stage = answerStage(await loadReadingProgress(under, readingId, execute));
  const early = await sendChallenge(under, readingId, "Please look.", execute);
  check(
    c.checks === EFFORT_CHECK_LIMIT - 1 && stage.kind === "answer" && early.status === "not_ready" && (await counts(under)).challenges === 0,
    `1 try, ${c.checks} checks: page ${stage.kind}, send ${early.status} (want answer, not_ready)`,
  );
}

async function answerRows(studentId: string, tryNumber: number) {
  return (await sql`
    select an.question_id, an.text, an.ai_pass, an.ai_feedback
    from answers an join attempts a on a.id = an.attempt_id
    join questions q on q.id = an.question_id
    where a.student_id = ${studentId} and a.reading_id = ${readingId} and a.try_number = ${tryNumber}
    order by q.position`) as { question_id: string; text: string; ai_pass: boolean; ai_feedback: string | null }[];
}

async function checkLockedAnswers() {
  console.log("\n== PASSED ANSWERS ARE LOCKED ==");
  const student = await newStudent();
  const calls = modelCalls;
  const first = await submit(student, "first", { delayMs: 5, entries: answers(questionIds, "My first answer.") });
  check(first.status === "checked" && !first.passed && lastChecked.length === 3, `try 1 checks all 3, q1 passes: ${first.status}`);
  const row = (await listReadingsWithStatus(classId, student, execute)).find((r) => r.id === readingId);
  check(row ? doneLabel(row.passedAnswers, row.questionCount) === "1 of 3 done" : false, `class list after try 1: ${row ? doneLabel(row.passedAnswers, row.questionCount) : "missing"}`);
  check((await openQuestionIds(execute, student, readingId)).join(",") === questionIds.slice(1).join(","), "open after try 1: q2 and q3");

  // A crafted form that still sends q1 (changed): refused before any claim.
  const before = modelCalls;
  const crafted = await submit(student, "pass", { delayMs: 5, entries: answers(questionIds, "Changed!") });
  let c = await counts(student);
  check(crafted.status === "stale" && modelCalls === before && c.checks === 1, `crafted form with q1: ${crafted.status}, no model call, checks ${c.checks}`);

  // An outage in between: given back, the lock and the try stay.
  const outage = await submit(student, "outage", { delayMs: 5 });
  c = await counts(student);
  check(outage.status === "check_failed" && c.attempts === 1 && lastChecked.join(",") === questionIds.slice(1).join(","), `outage on try 2 (checked q2, q3 only): ${outage.status}, attempts ${c.attempts}`);

  // Try 2 sends only q2 and q3 and passes; q1 is carried over as it was.
  const second = await submit(student, "pass", { delayMs: 5 });
  check(
    second.status === "checked" && second.passed && second.tryNumber === 2 && second.results.length === 2,
    `try 2: ${second.status}, passed ${second.status === "checked" && second.passed}, results ${second.status === "checked" ? second.results.length : "-"}`,
  );
  check(lastChecked.join(",") === questionIds.slice(1).join(","), `try 2 checked ${lastChecked.length} questions (q2, q3)`);
  const rows = await answerRows(student, 2);
  check(
    rows.length === 3 && rows[0].question_id === questionIds[0] && rows[0].text === "My first answer." && rows[0].ai_pass && rows[0].ai_feedback === null,
    `try 2 holds all 3 answers, q1 as it was: ${rows.map((r) => `${r.ai_pass ? "pass" : "fail"}`).join(",")}`,
  );
  const counted = await one<{ counted: number; given_back: number }>(sql`
    select count(*) filter (where outcome is distinct from 'given_back')::int as counted,
      count(*) filter (where outcome = 'given_back')::int as given_back
    from effort_checks where student_id = ${student} and reading_id = ${readingId}`);
  check(
    counted.counted === 2 && counted.given_back === 1 && modelCalls - calls === 3,
    `counting: ${counted.counted} counted checks (want 2), ${counted.given_back} given back (want 1), model calls ${modelCalls - calls} (want 3)`,
  );
  check((await statusOf(student)) === "passed", "status: passed");
  const stage = answerStage(await loadReadingProgress(student, readingId, execute));
  check(stage.kind === "passed" && stage.attempt?.tryNumber === 2 && Object.keys(stage.attempt.answers).length === 3, `page: ${stage.kind}, try 2 with every answer`);

  // A crafted commit straight to the store (past the form's checks) with a
  // failing, changed q1: the SQL keeps the locked answer.
  const direct = await newStudent();
  await submit(direct, "first", { delayMs: 5, entries: answers(questionIds, "Kept answer.") });
  const store = postgresAttemptStore(execute);
  const claimId = crypto.randomUUID();
  const claimed = await store.claim(direct, readingId, claimId, 1);
  const saved = await store.commit({
    studentId: direct,
    readingId,
    claimId,
    attemptId: crypto.randomUUID(),
    passed: false,
    verdicts: questionIds.map((questionId) => ({ questionId, text: "Overwritten", pass: false, nudge: "No." })),
  });
  const kept = await answerRows(direct, 2);
  check(
    claimed === "claimed" && saved === 2 && kept[0].text === "Kept answer." && kept[0].ai_pass && kept[1].text === "Overwritten",
    `crafted commit: q1 ${kept[0]?.ai_pass ? "still passed" : "CHANGED"} with its text ${kept[0]?.text === "Kept answer." ? "kept" : "CHANGED"}, q2 saved`,
  );
  const wrongTries = await store.claim(direct, readingId, crypto.randomUUID(), 1);
  check(wrongTries === "stale", `a claim for an older try count: ${wrongTries}`);

  // Out of tries with q1 locked: the note to the teacher still opens, and
  // the teacher's queue shows every answer of the last try.
  const stuck = await newStudent();
  await submit(stuck, "first", { delayMs: 5 });
  await submit(stuck, "fail", { delayMs: 5 });
  await submit(stuck, "fail", { delayMs: 5 });
  const last = await answerRows(stuck, 3);
  check(
    last.length === 3 && last.map((r) => r.ai_pass).join(",") === "true,true,false",
    `3rd try holds q1 (locked on try 1), q2 (locked on try 2), q3 failing: ${last.map((r) => r.ai_pass).join(",")}`,
  );
  const note = await sendChallenge(stuck, readingId, "Please look.", execute);
  check(note.status === "sent", `note after 3 tries with locked answers: ${note.status}`);
  const queue = queueItems(await execute(queueStatements(classId, teacherId)));
  const item = queue.find((q) => q.studentId === stuck);
  check(
    item?.questions.length === 3 && item.questions.every((q) => q.answer !== null) && item.questions.filter((q) => q.answer?.pass).length === 2,
    `teacher's queue: ${item?.questions.filter((q) => q.answer?.pass).length ?? "-"} of ${item?.questions.length ?? "-"} answers passed, none missing`,
  );
}

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id = ${`test_answers_${RUN_ID}`} returning id`;
  const left = await one<{ n: number }>(sql`
    select (select count(*) from students where session_token_hash like ${`hash_answers_${RUN_ID}_%`})::int as n`);
  console.log(
    `\ncleanup: deleted ${rows.length} test teacher (and everything under it, by cascade); students left: ${left.n}`,
  );
  if (left.n !== 0) failures.push(`cleanup left ${left.n} students`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}, db concurrency ${DB_CONCURRENCY}`);
  try {
    await setup();
    await checkNormalFlow();
    const outOfTries = await checkRace();
    await checkModelFailureAndLimit();
    await checkGivenBack();
    await checkStaleClaim();
    await checkRefusals();
    await checkChallenges(outOfTries);
    await checkCheckLimit();
    await checkLockedAnswers();
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
  console.error("check-student-answers crashed:", error);
  process.exit(1);
});
