// Checks self-learner mode (PR 13) through the real neon-http driver and
// the real cores, with a MOCK model (no model calls):
//
// (a) Role: a new account (the webhook's user.created upsert) has no role;
//     the first-run choice refuses self-learner without the age
//     confirmation, saves it with one, and a second first-run choice is
//     already_chosen; the settings switch goes teacher and back with every
//     row kept; the database itself refuses a self-learner row with no age
//     confirmation (teachers_self_learner_age_check).
// (b) Isolation: a self-learner can't reach a teacher's class reading
//     through any self-learner core (lookup, questions, answers, progress,
//     history); the teacher can't read the self-learner's reading through
//     them; a second self-learner can't either. All not_found or empty,
//     with nothing written.
// (c) Allowance: --creates concurrent creates leave exactly 5 in the window.
// (c3) Refused opens keep the slot (PR 16 review A1): an account at its
//     question limit (QUESTION_GENERATION_LIMIT generations in the
//     window) creates and opens readings over and over; every open is
//     rate_limited with no model call and keeps its slot, so the account
//     stops at the allowance (no 6th reading) instead of cycling slots.
//     After the wait, a kept reading gets its questions on the slot it
//     held, with no second slot.
// (d) The window rolls: backdated to 7 days minus a minute it still
//     blocks; with the oldest just past 7 days, exactly one more fits.
// (e) Solo flow: 3 failed tries, then moved on (a 4th is out_of_tries),
//     with zero challenge rows anywhere for it; a passing answer marks
//     another reading passed; --submits parallel submits save one try.
// (e3) Passed answers are locked: q1 passes on try 1; try 2 sends only q2
//     and q3; a crafted form with q1 is "stale" (no claim, no model call);
//     a crafted commit straight at the statements can't replace q1; a
//     given-back check in between keeps the lock and the try; the reading
//     passes on try 2 with q1 as it was; 2 counted checks, 3 model calls.
// (g) Failed creates use nothing (the /learn/new error page bug): through
//     createSelfReadingWith inside guardCreate, as the action runs it, with
//     the real allowance read, link fetch record and create transaction: a
//     create whose account lookup throws or passes the pre-write deadline,
//     or whose allowance read passes it, leaves no row, the allowance
//     unchanged and no link_fetch_attempts row, and returns every value; a
//     create transaction that fails after its insert (1/0 as its last
//     statement) rolls the insert back: no row, the allowance unchanged; a
//     link create whose transaction fails keeps its one link fetch record
//     (it limits fetches, not readings) and uses no slot; then a create
//     works and takes exactly one slot. A teacher create (the real insert)
//     whose teacher lookup or class check fails, or whose insert fails,
//     writes no reading.
// (f) Delete: user.deleted through handleClerkEvent leaves zero rows of
//     the account in every self-learner table (counted per table) and the
//     other account's rows intact; a repeat is already_gone.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-self-learner [flags]
//
// Flags:
//   --creates=20   concurrent creates for (c) (default 20)
//   --submits=10   parallel submits for (e) (default 10)
//
// Same database guard, connection cap, and NEON_FETCH_ENDPOINT handling as
// every check (scripts/lib/db-check.ts). Writes
// accounts named test_self_*_<run> and deletes them (and everything under
// them) at the end through the webhook's delete. Never run against
// production.
import { randomUUID } from "node:crypto";
import { getSql } from "@/db";
import { setRoleOutcome, setRoleStatements, type AccountRole, type SetRoleOutcome } from "@/lib/account-role";
import type { EffortCheckInput, EffortVerdict } from "@/lib/ai/effort-check";
import { QuestionWriterError } from "@/lib/ai/questions";
import { deletedAccountRows, deleteTeacherStatements, handleClerkEvent } from "@/lib/clerk-webhook";
import { neonExecutor } from "@/lib/neon-executor";
import { selfClaimCheckStatements, selfCommitStatements, soloStage } from "@/lib/self-answers-core";
import {
  claimOutcome,
  committedTry,
  EFFORT_CHECK_LIMIT,
  EFFORT_GIVEN_BACK_WINDOW_LIMIT,
  EFFORT_GIVEN_BACK_WINDOW_MINUTES,
} from "@/lib/submit-answers-core";
import { allowanceFor } from "@/lib/self-allowance";
import { QUESTION_GENERATION_LIMIT } from "@/lib/question-rate-limit";
import {
  createSelfReading,
  getAllowance,
  getOrCreateSelfQuestions,
  getSelfReading,
  listSelfHistory,
  loadSelfProgress,
  submitSelfAnswers,
} from "@/lib/self-readings";
import { createAccountStatements, hashClerkUserId } from "@/lib/deleted-accounts";
import { guardCreate, readingSaveFailedState } from "@/lib/create-guard";
import { recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { SAVE_READING_FAILED_MESSAGE } from "@/lib/reading-source";
import { insertReading } from "@/lib/readings";
import { createOutcome, createSelfReadingStatements } from "@/lib/self-allowance";
import { createSelfReadingWith, type SelfCreateDeps } from "@/lib/self-reading-create";
import { createTeacherReadingWith, type TeacherCreateDeps } from "@/lib/teacher-reading-create";
import { readingFormValues, type ReadingFormInput } from "@/lib/validate-reading";
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

const CREATES = intFlag("creates", 20);
const SUBMITS = intFlag("submits", 10);
const RUN_ID = Math.random().toString(36).slice(2, 10);
const BODY = "Mia walked to the river after the storm and found a fox. ".repeat(10);
const PROMPTS = ["Why did Mia go to the river?", "What did the fox do?", "What do you think, and why?"];
const PREFIXES = ["test_self_new", "test_self_a", "test_self_b", "test_self_c", "test_self_d", "test_self_teacher", "test_self_gone", "test_self_kept", "test_self_create"];
const FREE = allowanceFor("free");

const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

const clerkId = (prefix: string) => `${prefix}_${RUN_ID}`;

// The mock model and checkers: instant, never the real model.
const write = async (): Promise<string[]> => PROMPTS;
function checker(pass: boolean) {
  return async (input: EffortCheckInput): Promise<EffortVerdict[]> =>
    input.items.map((i) => ({ questionId: i.questionId, pass, nudge: pass ? "" : "Name one detail from the text." }));
}

function setRole(accountId: string, role: AccountRole, confirmAge: boolean, firstRun: boolean): Promise<SetRoleOutcome> {
  return neonExecutor(setRoleStatements(accountId, role, confirmAge, firstRun)).then((r) =>
    setRoleOutcome(r, role, firstRun),
  );
}

async function newAccount(prefix: string, role: AccountRole | null): Promise<string> {
  const { id } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, role, age_confirmed_at)
    values (${clerkId(prefix)}, 'test@example.invalid', ${role}::account_role,
      ${role === "self_learner" ? new Date().toISOString() : null}::timestamptz)
    returning id`);
  return id;
}

// A self-learner reading straight in the table (for the cases that need
// more than the allowance allows).
async function rawReading(accountId: string, title: string): Promise<string> {
  const { id } = await one<{ id: string }>(sql`
    insert into self_readings (account_id, title, body_text, grade_level, question_count)
    values (${accountId}, ${title}, ${BODY}, '5', ${PROMPTS.length})
    returning id`);
  return id;
}

function answersFor(questions: { id: string }[]) {
  return questions.map((q, i) => ({ questionId: q.id, value: `My answer number ${i + 1} about the fox` }));
}

async function readyQuestions(accountId: string, readingId: string) {
  const result = await getOrCreateSelfQuestions(accountId, readingId, { write });
  return result.status === "ready" ? result.questions : [];
}

const SELF_TABLES = ["self_readings", "self_questions", "self_attempts", "self_answers", "self_effort_checks"] as const;

async function selfCounts(accountId: string): Promise<Record<string, number>> {
  const row = await one<Record<string, number>>(sql`
    select
      (select count(*)::int from self_readings where account_id = ${accountId}) as self_readings,
      (select count(*)::int from self_questions q join self_readings r on r.id = q.reading_id where r.account_id = ${accountId}) as self_questions,
      (select count(*)::int from self_attempts where account_id = ${accountId}) as self_attempts,
      (select count(*)::int from self_answers an join self_attempts a on a.id = an.attempt_id where a.account_id = ${accountId}) as self_answers,
      (select count(*)::int from self_effort_checks where account_id = ${accountId}) as self_effort_checks`);
  return row;
}

// ---------------------------------------------------------------------------

async function checkRole() {
  console.log("\n== (a) ROLE ==");
  const created = await handleClerkEvent(
    {
      type: "user.created",
      data: { id: clerkId("test_self_new"), first_name: "Test", email_addresses: [{ id: "idn_1", email_address: "new@example.invalid" }] },
    },
    neonExecutor,
  );
  const row = await one<{ id: string; role: string | null; age: string | null }>(
    sql`select id, role, age_confirmed_at as age from teachers where clerk_user_id = ${clerkId("test_self_new")}`,
  );
  check(created === "upserted" && row.role === null && row.age === null, `a new account has no role and no age (${created}, ${row.role})`);

  const noAge = await setRole(row.id, "self_learner", false, true);
  check(noAge.status === "age_required", `self-learner without the age confirmation is refused: ${noAge.status}`);
  const still = await one<{ role: string | null }>(sql`select role from teachers where id = ${row.id}`);
  check(still.role === null, "...and the role stays unset");

  const chosen = await setRole(row.id, "self_learner", true, true);
  const afterChoice = await one<{ role: string; age: string | null }>(
    sql`select role, age_confirmed_at::text as age from teachers where id = ${row.id}`,
  );
  check(chosen.status === "saved" && afterChoice.role === "self_learner" && afterChoice.age !== null, `the first-run choice saves role and age: ${chosen.status}`);

  const again = await Promise.all([setRole(row.id, "teacher", false, true), setRole(row.id, "self_learner", true, true)]);
  check(
    again.every((o) => o.status === "already_chosen" && o.role === "self_learner"),
    `a second first-run choice (twice at once) changes nothing: ${again.map((o) => o.status).join(", ")}`,
  );

  const readingId = await rawReading(row.id, "Kept reading");
  const before = await selfCounts(row.id);
  const toTeacher = await setRole(row.id, "teacher", false, false);
  const toTeacherAgain = await setRole(row.id, "teacher", false, false);
  const asTeacher = await selfCounts(row.id);
  check(toTeacher.status === "saved" && toTeacherAgain.status === "saved", `switch to teacher (twice, idempotent): ${toTeacher.status}, ${toTeacherAgain.status}`);
  check(JSON.stringify(asTeacher) === JSON.stringify(before), "...and every self-learner row is kept");
  const back = await setRole(row.id, "self_learner", false, false);
  check(back.status === "saved", `switch back to self-learner needs no new age box (confirmed before): ${back.status}`);
  const reading = await getSelfReading(row.id, readingId);
  check(reading?.title === "Kept reading", "...and the old reading is there again");
  const ageKept = await one<{ same: boolean }>(
    sql`select age_confirmed_at::text = ${afterChoice.age} as same from teachers where id = ${row.id}`,
  );
  check(ageKept.same === true, "...and the first confirmation time is kept, not overwritten");

  const fresh = await newAccount("test_self_teacher", "teacher");
  const freshSwitch = await setRole(fresh, "self_learner", false, false);
  check(freshSwitch.status === "age_required", `a teacher switching to self-learner for the first time needs the age box: ${freshSwitch.status}`);
  let constraint = "none";
  try {
    await sql`update teachers set role = 'self_learner' where id = ${fresh}`;
  } catch (error) {
    constraint = String((error as { code?: unknown }).code);
  }
  check(constraint === "23514", `the database refuses a self-learner with no age confirmation (${constraint})`);
}

let teacherId = "";
let teacherReadingId = "";
let studentId = "";
let aId = "";
let bId = "";

async function checkIsolation() {
  console.log("\n== (b) ISOLATION ==");
  teacherId = (await one<{ id: string }>(sql`select id from teachers where clerk_user_id = ${clerkId("test_self_teacher")}`)).id;
  const { id: classId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Isolation class', '5', ${`S${RUN_ID}`.toUpperCase()}) returning id`);
  ({ id: teacherReadingId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Class reading', ${BODY}, 3, 'per_student', 'published') returning id`));
  ({ id: studentId } = await one<{ id: string }>(sql`
    insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
    values (${classId}, 'Testa', 'Ro', 'testa ro', ${`self_${RUN_ID}_hash`}) returning id`));
  await sql`insert into questions (reading_id, student_id, position, prompt) values (${teacherReadingId}, ${studentId}, 1, 'Class question?')`;

  aId = await newAccount("test_self_a", "self_learner");
  bId = await newAccount("test_self_b", "self_learner");
  const aReading = await rawReading(aId, "A's reading");
  const aQuestions = await readyQuestions(aId, aReading);
  check(aQuestions.length === 3, `the owner gets their questions (${aQuestions.length})`);

  // A self-learner aimed at the teacher's class reading (and the student).
  for (const [who, id] of [["self-learner A", aId], ["the teacher", teacherId], ["self-learner B", bId]] as const) {
    const target = who === "self-learner A" ? teacherReadingId : aReading;
    const looked = await getSelfReading(id, target);
    const questions = await getOrCreateSelfQuestions(id, target, { write });
    const submitted = await submitSelfAnswers(id, target, answersFor(aQuestions), { check: checker(true) });
    const progress = await loadSelfProgress(id, target);
    check(
      looked === undefined && questions.status === "not_found" && submitted.status === "not_found" && progress.attempts.length === 0,
      `${who} gets not_found through every self-learner core (${questions.status}, ${submitted.status})`,
    );
  }
  const viaStudent = await getOrCreateSelfQuestions(studentId, teacherReadingId, { write });
  check(viaStudent.status === "not_found", `a student id as the account reaches nothing: ${viaStudent.status}`);
  const history = await listSelfHistory(aId, "UTC");
  check(history.length === 1 && history[0].title === "A's reading", `A's history has only A's reading (${history.length})`);
  const bHistory = await listSelfHistory(bId, "UTC");
  check(bHistory.length === 0, `B's history is empty (${bHistory.length})`);
  const teacherHistory = await listSelfHistory(teacherId, "UTC");
  check(teacherHistory.length === 0, `the teacher's history never lists class readings (${teacherHistory.length})`);
  const leaks = await one<{ n: number }>(sql`
    select (select count(*)::int from self_effort_checks where reading_id = ${aReading} and account_id <> ${aId})
      + (select count(*)::int from self_attempts where reading_id = ${aReading} and account_id <> ${aId})
      + (select count(*)::int from questions where reading_id = ${teacherReadingId}) - 1 as n`);
  check(leaks.n === 0, `nothing was written by the refused calls (${leaks.n})`);
  const teacherCreate = await createSelfReading(teacherId, { title: "x", bodyText: BODY, sourceUrl: null, bodyTrimmed: false, gradeLevel: "5", questionCount: 3 });
  check(teacherCreate.status === "not_allowed", `a teacher can't create a self-learner reading: ${teacherCreate.status}`);
  await sql`delete from self_readings where account_id = ${aId}`;
}

async function checkAllowance() {
  console.log("\n== (c) ALLOWANCE ==");
  const draft = (i: number) => ({ title: `Burst ${i}`, bodyText: BODY, sourceUrl: null, bodyTrimmed: false, gradeLevel: "5" as const, questionCount: 3 });
  const outcomes = await Promise.all(Array.from({ length: CREATES }, (_, i) => createSelfReading(aId, draft(i))));
  const created = outcomes.filter((o) => o.status === "created").length;
  const limited = outcomes.filter((o) => o.status === "limit_reached").length;
  const rows = await one<{ n: number }>(sql`select count(*)::int as n from self_readings where account_id = ${aId}`);
  check(created === FREE.readings && rows.n === FREE.readings, `${CREATES} concurrent creates: ${created} created, ${rows.n} rows (want ${FREE.readings})`);
  check(limited === CREATES - FREE.readings, `...the other ${limited} were told the limit`);
  const state = await getAllowance(aId);
  check(state.remaining === 0 && state.nextFreeAt !== null, `allowance shows 0 left with a next free time (${state.nextFreeAt?.toISOString()})`);

  console.log("\n== (d) ROLLING WINDOW ==");
  // Spread the 5 over the week, the oldest 7 days minus a minute old.
  await sql`
    update self_readings set created_at = now() - interval '7 days' + interval '1 minute' + (n.i * interval '1 hour')
    from (select id, row_number() over (order by id) - 1 as i from self_readings where account_id = ${aId}) n
    where self_readings.id = n.id`;
  const blocked = await createSelfReading(aId, draft(100));
  check(blocked.status === "limit_reached", `at 7 days minus a minute it still blocks: ${blocked.status}`);
  if (blocked.status === "limit_reached") {
    const minutes = ((blocked.state.nextFreeAt?.getTime() ?? 0) - Date.now()) / 60_000;
    check(minutes > 0 && minutes <= 1.5, `...and the next one frees up in about a minute (${minutes.toFixed(2)} min)`);
  }
  await sql`
    update self_readings set created_at = now() - interval '7 days' - interval '1 minute'
    where id = (select id from self_readings where account_id = ${aId} order by created_at limit 1)`;
  const freed = await Promise.all([createSelfReading(aId, draft(101)), createSelfReading(aId, draft(102)), createSelfReading(aId, draft(103))]);
  check(
    freed.filter((o) => o.status === "created").length === 1,
    `past 7 days exactly one frees up (3 at once: ${freed.map((o) => o.status).join(", ")})`,
  );
  const inWindow = await one<{ n: number }>(sql`
    select count(*)::int as n from self_readings where account_id = ${aId} and created_at > now() - interval '7 days'`);
  check(inWindow.n === FREE.readings, `...leaving ${inWindow.n} in the window`);
}

// A reading whose questions never get written gives its weekly slot back;
// its Try again takes one back only while one is free, and creates racing
// Try agains never pass the allowance.
async function checkFailedGenerations() {
  console.log("\n== (c2) FAILED GENERATIONS DON'T USE A SLOT ==");
  const cId = await newAccount("test_self_c", "self_learner");
  const draft = (i: number) => ({ title: `Slot ${i}`, bodyText: BODY, sourceUrl: null, bodyTrimmed: false, gradeLevel: "5" as const, questionCount: 3 });
  const failing = async (): Promise<string[]> => {
    throw new QuestionWriterError("failed", "a fake outage");
  };
  const failed: string[] = [];
  for (let i = 0; i < FREE.readings; i++) {
    const created = await createSelfReading(cId, draft(i));
    if (created.status !== "created") break;
    const opened = await getOrCreateSelfQuestions(cId, created.id, { write: failing });
    if (opened.status === "error") failed.push(created.id);
  }
  const afterFail = await getAllowance(cId);
  check(
    failed.length === FREE.readings && afterFail.remaining === FREE.readings,
    `${failed.length} readings whose questions failed leave all ${afterFail.remaining} of ${FREE.readings} slots free`,
  );
  const held: string[] = [];
  const more = await Promise.all(Array.from({ length: FREE.readings + 3 }, (_, i) => createSelfReading(cId, draft(10 + i))));
  for (const o of more) if (o.status === "created") held.push(o.id);
  check(held.length === FREE.readings, `then ${FREE.readings + 3} creates at once make exactly ${FREE.readings} (${held.length})`);
  for (const id of held) await readyQuestions(cId, id);
  const full = await getAllowance(cId);
  check(full.remaining === 0, `readings with questions hold their slots (${full.remaining} left)`);

  let writes = 0;
  const counting = async (): Promise<string[]> => {
    writes++;
    return PROMPTS;
  };
  const retry = await getOrCreateSelfQuestions(cId, failed[0], { write: counting });
  check(
    retry.status === "limit_reached" && writes === 0 && retry.state.nextFreeAt !== null,
    `a Try again on a released reading with no free slot: ${retry.status}, ${writes} model calls`,
  );

  // Free exactly one slot (the oldest held reading leaves the window), then
  // race 3 Try agains on released readings against 3 creates.
  await sql`update self_readings set created_at = now() - interval '8 days' where id = ${held[0]}`;
  const raced = await Promise.all([
    ...failed.slice(0, 3).map((id) => getOrCreateSelfQuestions(cId, id, { write: counting })),
    ...[1, 2, 3].map((i) => createSelfReading(cId, draft(100 + i))),
  ]);
  const won = raced.filter((r) => r.status === "ready" || r.status === "created").length;
  const nowHeld = await one<{ n: number }>(sql`
    select count(*)::int as n from self_readings
    where account_id = ${cId} and slot_released_at is null and created_at > now() - interval '7 days'`);
  check(
    won === 1 && nowHeld.n === FREE.readings,
    `one free slot, 3 Try agains and 3 creates at once: exactly ${won} got it, ${nowHeld.n} slots held (${raced.map((r) => r.status).join(", ")})`,
  );
  const withQuestions = await one<{ n: number }>(sql`
    select count(*)::int as n from self_readings r
    where r.account_id = ${cId} and r.slot_released_at is not null
      and exists (select 1 from self_questions q where q.reading_id = r.id)`);
  check(withQuestions.n === 0, `no reading with questions is ever marked released (${withQuestions.n})`);
}

// PR 16 review A1: an open refused by the question limit used to give the
// slot back, so an account at the limit could create, open and repeat
// past the allowance. Now a refused open keeps the slot.
async function checkRateLimitedKeepsSlot() {
  console.log("\n== (c3) RATE-LIMITED OPENS KEEP THEIR SLOT ==");
  const dId = await newAccount("test_self_d", "self_learner");
  const draft = (i: number) => ({ title: `Loop ${i}`, bodyText: BODY, sourceUrl: null, bodyTrimmed: false, gradeLevel: "5" as const, questionCount: 3 });
  // At the question limit: the limiter's own rows, inside its window.
  await sql`
    insert into question_generation_attempts (teacher_id)
    select ${dId}::uuid from generate_series(1, ${QUESTION_GENERATION_LIMIT}::int)`;
  let writes = 0;
  const counting = async (): Promise<string[]> => {
    writes++;
    return PROMPTS;
  };
  const created: string[] = [];
  const opens: string[] = [];
  const creates: string[] = [];
  for (let i = 0; i < FREE.readings + 3; i++) {
    const made = await createSelfReading(dId, draft(i));
    creates.push(made.status);
    if (made.status !== "created") continue;
    created.push(made.id);
    opens.push((await getOrCreateSelfQuestions(dId, made.id, { write: counting })).status);
  }
  const released = await one<{ n: number }>(sql`
    select count(*)::int as n from self_readings where account_id = ${dId} and slot_released_at is not null`);
  check(
    opens.length === FREE.readings && opens.every((s) => s === "rate_limited") && writes === 0,
    `${opens.length} opens at the question limit: all rate_limited, ${writes} model calls (${opens.join(", ")})`,
  );
  check(released.n === 0, `...and every one kept its slot (${released.n} released)`);
  check(
    created.length === FREE.readings && creates.slice(FREE.readings).every((s) => s === "limit_reached"),
    `create, open, repeat ${FREE.readings + 3} times stops at ${created.length} readings (${creates.join(", ")})`,
  );
  const rows = await one<{ n: number }>(sql`select count(*)::int as n from self_readings where account_id = ${dId}`);
  const state = await getAllowance(dId);
  check(rows.n === FREE.readings && state.remaining === 0, `${rows.n} rows, ${state.remaining} slots left: the allowance wasn't regained`);

  // The wait passes: a kept reading gets its questions on its own slot.
  await sql`delete from question_generation_attempts where teacher_id = ${dId}`;
  const later = await getOrCreateSelfQuestions(dId, created[0], { write: counting });
  const held = await one<{ n: number }>(sql`
    select count(*)::int as n from self_readings
    where account_id = ${dId} and slot_released_at is null and created_at > now() - interval '7 days'`);
  check(
    later.status === "ready" && writes === 1 && held.n === FREE.readings,
    `after the wait, Try again: ${later.status}, ${writes} model call, ${held.n} slots held (no second slot)`,
  );
}

async function checkSoloFlow() {
  console.log("\n== (e) SOLO FLOW ==");
  // Scoped to this run's accounts: the test database is shared, so another
  // run's challenges must not make this flaky.
  const runChallenges = () =>
    one<{ n: number }>(sql`
      select count(*)::int as n from challenges ch
      join students s on s.id = ch.student_id
      join classes c on c.id = s.class_id
      join teachers t on t.id = c.teacher_id
      where t.clerk_user_id like ${`%\_${RUN_ID}`}`);
  const challengesBefore = await runChallenges();
  const failing = await rawReading(bId, "Three tries");
  const questions = await readyQuestions(bId, failing);
  for (let i = 1; i <= 3; i++) {
    const r = await submitSelfAnswers(bId, failing, answersFor(questions), { check: checker(false) });
    check(r.status === "checked" && !r.passed && r.tryNumber === i, `try ${i} fails: ${r.status}`);
  }
  const status = await one<{ status: string; finished: boolean }>(
    sql`select status, finished_at is not null as finished from self_readings where id = ${failing}`,
  );
  check(status.status === "moved_on" && status.finished, `after 3 failed tries the reading is moved on (${status.status})`);
  const stage = soloStage(await loadSelfProgress(bId, failing));
  check(stage.kind === "moved_on" && stage.attempt?.tryNumber === 3, `the page shows the last try's nudges: ${stage.kind}`);
  const fourth = await submitSelfAnswers(bId, failing, answersFor(questions), { check: checker(true) });
  check(fourth.status === "out_of_tries", `a 4th try is refused: ${fourth.status}`);
  const challengesAfter = await runChallenges();
  const own = await one<{ n: number }>(sql`select count(*)::int as n from challenges where reading_id = ${failing}`);
  check(challengesAfter.n === challengesBefore.n && own.n === 0, `zero challenge rows for it, none new for this run's accounts (${challengesBefore.n} -> ${challengesAfter.n})`);

  const passing = await rawReading(bId, "Pass it");
  const passQuestions = await readyQuestions(bId, passing);
  const parallel = await Promise.all(
    Array.from({ length: SUBMITS }, () => submitSelfAnswers(bId, passing, answersFor(passQuestions), { check: checker(true) })),
  );
  const checked = parallel.filter((r) => r.status === "checked").length;
  check(checked === 1, `${SUBMITS} parallel submits save exactly one try (${parallel.map((r) => r.status).join(", ")})`);
  const passed = await one<{ status: string; tries: number }>(sql`
    select status, (select count(*)::int from self_attempts where reading_id = ${passing}) as tries
    from self_readings where id = ${passing}`);
  check(passed.status === "passed" && passed.tries === 1, `a passing answer marks it passed (${passed.status}, ${passed.tries} try)`);
  const history = await listSelfHistory(bId, "UTC");
  check(
    history[0]?.result === "passed" && history[1]?.result === "moved_on",
    `history lists them newest first with results: ${history.map((h) => h.result).join(", ")}`,
  );
  check(
    history[0]?.doneLabel === "" && history[1]?.doneLabel === "",
    `passed and moved-on rows have no done hint (${JSON.stringify(history.slice(0, 2).map((h) => h.doneLabel))})`,
  );

  // In progress: "X of Y done" counts the passed answers on the latest try.
  const halfway = await rawReading(bId, "Half way");
  const halfQuestions = await readyQuestions(bId, halfway);
  const fresh = (await listSelfHistory(bId, "UTC")).find((h) => h.id === halfway);
  check(fresh?.doneLabel === "0 of 3 done", `before any try: ${fresh?.doneLabel}`);
  const mixed = async (input: EffortCheckInput): Promise<EffortVerdict[]> =>
    input.items.map((i, n) => ({ questionId: i.questionId, pass: n < 2, nudge: n < 2 ? "" : "Name one detail from the text." }));
  const firstTry = await submitSelfAnswers(bId, halfway, answersFor(halfQuestions), { check: mixed });
  check(firstTry.status === "checked" && !firstTry.passed, `mixed try 1 saved, not passed: ${firstTry.status}`);
  const afterOne = (await listSelfHistory(bId, "UTC")).find((h) => h.id === halfway);
  check(afterOne?.result === "in_progress" && afterOne.doneLabel === "2 of 3 done", `after 2 of 3 passed: ${afterOne?.doneLabel}`);
  // Try 2 sends only the open question, and it fails: the passed ones stay
  // done (locked), so the count never goes down.
  const secondTry = await submitSelfAnswers(bId, halfway, answersFor(halfQuestions).slice(2), { check: checker(false) });
  check(secondTry.status === "checked" && !secondTry.passed, `try 2 fails the open answer: ${secondTry.status}`);
  const afterTwo = (await listSelfHistory(bId, "UTC")).find((h) => h.id === halfway);
  check(afterTwo?.doneLabel === "2 of 3 done", `passed answers stay done after a failing try: ${afterTwo?.doneLabel}`);
}

async function selfAnswerRows(readingId: string, tryNumber: number) {
  return (await sql`
    select an.question_id, an.text, an.ai_pass, an.ai_feedback
    from self_answers an join self_attempts a on a.id = an.attempt_id
    join self_questions q on q.id = an.question_id
    where a.reading_id = ${readingId} and a.try_number = ${tryNumber}
    order by q.position`) as { question_id: string; text: string; ai_pass: boolean; ai_feedback: string | null }[];
}

async function checkLockedAnswers() {
  console.log("\n== (e3) PASSED ANSWERS ARE LOCKED ==");
  const readingId = await rawReading(bId, "Locked answers");
  const questions = await readyQuestions(bId, readingId);
  const ids = questions.map((q) => q.id);
  let calls = 0;
  let seen: string[] = [];
  // Passes only the first question (`first`, q1 by default), or everything.
  const counting = (passAll: boolean, outage = false, first = ids[0]) => async (input: EffortCheckInput): Promise<EffortVerdict[]> => {
    calls++;
    seen = input.items.map((i) => i.questionId);
    if (outage) throw new Error("fake model outage");
    return input.items.map((i) => {
      const pass = passAll || i.questionId === first;
      return { questionId: i.questionId, pass, nudge: pass ? "" : "Name one detail from the text." };
    });
  };
  const all = answersFor(questions);
  const first = await submitSelfAnswers(bId, readingId, all, { check: counting(false) });
  check(first.status === "checked" && !first.passed && seen.length === 3, `try 1 checks all 3, q1 passes: ${first.status}`);
  const row = (await listSelfHistory(bId, "UTC")).find((h) => h.id === readingId);
  check(row?.doneLabel === "1 of 3 done", `history after try 1: ${row?.doneLabel}`);

  const crafted = await submitSelfAnswers(bId, readingId, all.map((a) => ({ ...a, value: "Changed!" })), { check: counting(true) });
  check(crafted.status === "stale" && calls === 1, `crafted form with q1: ${crafted.status}, no model call (${calls} calls)`);

  const outage = await submitSelfAnswers(bId, readingId, all.slice(1), { check: counting(true, true) });
  const tries = await one<{ n: number }>(sql`select count(*)::int as n from self_attempts where reading_id = ${readingId}`);
  check(outage.status === "check_failed" && tries.n === 1 && seen.join(",") === ids.slice(1).join(","), `outage on try 2 (checked q2, q3 only): ${outage.status}, ${tries.n} try saved`);

  const second = await submitSelfAnswers(bId, readingId, all.slice(1), { check: counting(true) });
  check(
    second.status === "checked" && second.passed && second.tryNumber === 2 && seen.join(",") === ids.slice(1).join(","),
    `try 2 checks only q2 and q3 and passes: ${second.status}, ${seen.length} checked`,
  );
  const rows = await selfAnswerRows(readingId, 2);
  check(
    rows.length === 3 && rows[0].question_id === ids[0] && rows[0].text === all[0].value && rows[0].ai_pass && rows[0].ai_feedback === null,
    `try 2 holds all 3 answers, q1 as it was: ${rows.map((r) => (r.ai_pass ? "pass" : "fail")).join(",")}`,
  );
  const counted = await one<{ counted: number; given_back: number; status: string }>(sql`
    select count(*) filter (where outcome is distinct from 'given_back')::int as counted,
      count(*) filter (where outcome = 'given_back')::int as given_back,
      (select status::text from self_readings where id = ${readingId}) as status
    from self_effort_checks where reading_id = ${readingId}`);
  check(
    counted.counted === 2 && counted.given_back === 1 && calls === 3 && counted.status === "passed",
    `counting: ${counted.counted} counted (want 2), ${counted.given_back} given back (want 1), ${calls} model calls (want 3), status ${counted.status}`,
  );

  // A crafted commit straight at the statements with a failing, changed q1.
  const direct = await rawReading(bId, "Locked, crafted commit");
  const directQuestions = await readyQuestions(bId, direct);
  await submitSelfAnswers(bId, direct, answersFor(directQuestions), { check: counting(false, false, directQuestions[0].id) });
  const claimId = randomUUID();
  const claimed = claimOutcome(await neonExecutor(selfClaimCheckStatements(bId, direct, claimId, 1)), 1);
  const saved = committedTry(
    await neonExecutor(
      selfCommitStatements({
        studentId: bId,
        readingId: direct,
        claimId,
        attemptId: randomUUID(),
        passed: false,
        verdicts: directQuestions.map((q) => ({ questionId: q.id, text: "Overwritten", pass: false, nudge: "No." })),
      }),
    ),
  );
  const kept = await selfAnswerRows(direct, 2);
  check(
    claimed === "claimed" && saved === 2 && kept[0]?.text === answersFor(directQuestions)[0].value && kept[0]?.ai_pass && kept[1]?.text === "Overwritten",
    `crafted commit: ${claimed}, try ${saved}, q1 ${kept[0]?.ai_pass ? "still passed" : "CHANGED"}, text ${kept[0]?.text === "Overwritten" ? "CHANGED" : "kept"}`,
  );
  const older = claimOutcome(await neonExecutor(selfClaimCheckStatements(bId, direct, randomUUID(), 1)), 1);
  check(older === "stale", `a claim for an older try count: ${older}`);
}

// A check with no model reply (an outage, not set up, out of credits) is
// given back: never toward the self-learner's check cap, and it never
// moves the reading on.
async function checkGivenBackChecks() {
  console.log("\n== (e3) GIVEN-BACK CHECKS ==");
  const readingId = await rawReading(bId, "Outage");
  const questions = await readyQuestions(bId, readingId);
  const outage = async (): Promise<EffortVerdict[]> => {
    throw new Error("fake model outage");
  };
  const statuses: string[] = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < EFFORT_GIVEN_BACK_WINDOW_LIMIT; i++) {
      statuses.push((await submitSelfAnswers(bId, readingId, answersFor(questions), { check: outage })).status);
    }
    const paused = await submitSelfAnswers(bId, readingId, answersFor(questions), { check: checker(true) });
    statuses.push(paused.status);
    await sql`update self_effort_checks set created_at = created_at - make_interval(mins => ${EFFORT_GIVEN_BACK_WINDOW_MINUTES + 1})
      where reading_id = ${readingId}`;
  }
  const rows = await one<{ n: number; counted: number; status: string }>(sql`
    select count(*)::int as n, count(*) filter (where e.outcome is distinct from 'given_back')::int as counted, r.status
    from self_readings r left join self_effort_checks e on e.reading_id = r.id
    where r.id = ${readingId} group by r.status`);
  check(
    rows.n === 3 * EFFORT_GIVEN_BACK_WINDOW_LIMIT && rows.counted === 0 && rows.status === "in_progress",
    `${rows.n} given-back checks (cap ${EFFORT_CHECK_LIMIT}): ${rows.counted} counted, reading ${rows.status}; each window ended paused (${statuses.filter((x) => x === "paused").length}x)`,
  );
  const pass = await submitSelfAnswers(bId, readingId, answersFor(questions), { check: checker(true) });
  check(pass.status === "checked" && pass.passed && pass.tryNumber === 1, `then a real check is try 1 and passes: ${pass.status}`);
}

// A role switch or another account's id between the read and the write:
// the claim and the commit re-check both in the statement, so nothing is
// saved.
async function checkRoleAndOwnerAtWrite() {
  console.log("\n== (e2) ROLE AND OWNER AT WRITE TIME ==");
  const readingId = await rawReading(bId, "Switch mid-check");
  const questions = await readyQuestions(bId, readingId);
  // The account switches to teacher while the check runs.
  const switching = async (input: EffortCheckInput): Promise<EffortVerdict[]> => {
    await sql`update teachers set role = 'teacher' where id = ${bId}`;
    return checker(true)(input);
  };
  const mid = await submitSelfAnswers(bId, readingId, answersFor(questions), { check: switching });
  const saved = await one<{ n: number }>(sql`select count(*)::int as n from self_attempts where reading_id = ${readingId}`);
  check(mid.status === "check_failed" && saved.n === 0, `a switch to teacher mid-check saves no try (${mid.status}, ${saved.n} saved)`);
  const asTeacher = await submitSelfAnswers(bId, readingId, answersFor(questions), { check: checker(true) });
  const claims = await one<{ n: number }>(
    sql`select count(*)::int as n from self_effort_checks where reading_id = ${readingId} and finished_at is null and created_at > now() - interval '1 minute'`,
  );
  check(asTeacher.status === "not_found", `as a teacher the claim itself refuses: ${asTeacher.status} (${claims.n} live claim left from the switch)`);
  await sql`update teachers set role = 'self_learner' where id = ${bId}`;

  // A's id against B's reading, straight at the statements: no claim, and
  // a commit with B's live claim id but A's account saves nothing.
  const claimId = randomUUID();
  const foreignClaim = claimOutcome(await neonExecutor(selfClaimCheckStatements(aId, readingId, claimId, 0)));
  check(foreignClaim === "not_found", `another account's claim on the reading: ${foreignClaim}`);
  await sql`update self_effort_checks set finished_at = now(), outcome = 'error' where reading_id = ${readingId} and finished_at is null`;
  const ownClaim = randomUUID();
  const own = claimOutcome(await neonExecutor(selfClaimCheckStatements(bId, readingId, ownClaim, 0)));
  const foreignCommit = committedTry(
    await neonExecutor(
      selfCommitStatements({
        studentId: aId,
        readingId,
        claimId: ownClaim,
        attemptId: randomUUID(),
        passed: true,
        verdicts: questions.map((q) => ({ questionId: q.id, text: "x", pass: true, nudge: "" })),
      }),
    ),
  );
  const after = await one<{ n: number }>(sql`select count(*)::int as n from self_attempts where reading_id = ${readingId}`);
  check(own === "claimed" && foreignCommit === null && after.n === 0, `a commit under another account's id saves nothing (${own}, ${foreignCommit}, ${after.n})`);
}

// AbortSignal.timeout's timer doesn't keep Node's event loop alive.
async function keepingAlive<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}

const never = <T>() => new Promise<T>(() => {});
const rethrowNext = (error: unknown) => {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
};

async function checkFailedCreates() {
  console.log("\n== (g) FAILED CREATES USE NOTHING ==");
  const eId = await newAccount("test_self_create", "self_learner");
  const text: ReadingFormInput = { source: "text", url: "", title: "Failed create", bodyText: BODY, gradeLevel: "6", questionCount: "4", questionMode: null };
  const link: ReadingFormInput = { ...text, source: "link", url: "https://example.invalid/story", bodyText: "" };
  // The real reads and writes; the fetch is a fake (no network).
  const real = (): SelfCreateDeps => ({
    requireAccount: async () => ({ id: eId }),
    getAllowance: (id) => getAllowance(id),
    recordLinkFetch: (id) => recordLinkFetchAttempt(id),
    linkLimitedMessage: async () => "limited",
    fetchArticle: async (url) => ({ title: "From the page", text: BODY, url, trimmed: false }),
    createSelfReading: (id, draft) => createSelfReading(id, draft),
    log: () => {},
  });
  const run = (input: ReadingFormInput, deps: SelfCreateDeps) =>
    keepingAlive(() =>
      guardCreate((preWrite) => createSelfReadingWith(input, preWrite, deps), () => ({ state: readingSaveFailedState(readingFormValues(input)) }), {
        rethrow: rethrowNext,
        onError: () => {},
        deadlineMs: 300,
      }),
    );
  const state = async () => {
    const row = await one<{ readings: number; fetches: number }>(sql`
      select (select count(*)::int from self_readings where account_id = ${eId}) as readings,
        (select count(*)::int from link_fetch_attempts where teacher_id = ${eId}) as fetches`);
    return { ...row, remaining: (await getAllowance(eId)).remaining };
  };
  const start = await state();
  check(start.readings === 0 && start.fetches === 0 && start.remaining === FREE.readings, `a fresh account: ${JSON.stringify(start)}`);

  const failures: { name: string; deps: (d: SelfCreateDeps) => SelfCreateDeps }[] = [
    { name: "the account lookup throws", deps: (d) => ({ ...d, requireAccount: async () => Promise.reject(new Error("fetch failed")) }) },
    { name: "the account lookup passes the deadline", deps: (d) => ({ ...d, requireAccount: never }) },
    { name: "the allowance read passes the deadline", deps: (d) => ({ ...d, getAllowance: never }) },
  ];
  for (const { name, deps } of failures) {
    for (const input of [text, link]) {
      const result = await run(input, deps(real()));
      const kept = "state" in result && result.state.errors?.form === SAVE_READING_FAILED_MESSAGE && result.state.values?.bodyText === input.bodyText && result.state.values?.url === input.url;
      check(kept && JSON.stringify(await state()) === JSON.stringify(start), `${name} (${input.source}): the form keeps everything; no row, no slot, no fetch record`);
    }
  }

  // The create transaction fails after its insert ran: Postgres rolls the
  // whole batch back.
  const failingTransaction = (d: SelfCreateDeps): SelfCreateDeps => ({
    ...d,
    createSelfReading: async (id, draft) =>
      createOutcome(await neonExecutor([...createSelfReadingStatements(id, draft, FREE), { text: "select 1/0", params: [] }]), FREE),
  });
  const failedText = await run(text, failingTransaction(real()));
  check(
    "state" in failedText && failedText.state.errors?.form === SAVE_READING_FAILED_MESSAGE && failedText.state.values?.bodyText === BODY,
    "a failed create transaction: the form keeps everything",
  );
  check(JSON.stringify(await state()) === JSON.stringify(start), `...no row, the allowance unchanged (${JSON.stringify(await state())})`);
  const failedLink = await run(link, failingTransaction(real()));
  const afterLink = await state();
  check(
    "state" in failedLink && afterLink.readings === 0 && afterLink.remaining === FREE.readings && afterLink.fetches === 1,
    `a link whose transaction fails: its fetch is counted (limits fetches), no slot used (${JSON.stringify(afterLink)})`,
  );

  const created = await run(text, real());
  const after = await state();
  check("redirect" in created && created.redirect.path.startsWith("/learn/r/") && created.redirect.type === "replace", "then a create works");
  check(after.readings === 1 && after.remaining === FREE.readings - 1 && after.fetches === 1, `...taking exactly one slot (${JSON.stringify(after)})`);

  // A teacher's create, with the real insert.
  const { id: classId } = await one<{ id: string }>(sql`select id from classes where teacher_id = ${teacherId} limit 1`);
  const classReadings = async () => (await one<{ n: number }>(sql`select count(*)::int as n from readings where class_id = ${classId}`)).n;
  const before = await classReadings();
  const teacherInput: ReadingFormInput = { ...text, gradeLevel: "", questionMode: "per_student" };
  const teacherDeps = (over: Partial<TeacherCreateDeps>): TeacherCreateDeps => ({
    requireTeacher: async () => ({ id: teacherId }),
    ownsClass: async () => true,
    recordLinkFetch: async () => true,
    linkLimitedMessage: async () => "limited",
    fetchArticle: async (url) => ({ title: "Page", text: BODY, url, trimmed: false }),
    insertReading: (c, t, draft) => insertReading(c, t, draft),
    log: () => {},
    ...over,
  });
  const teacherFailures: { name: string; over: Partial<TeacherCreateDeps> }[] = [
    { name: "the teacher lookup throws", over: { requireTeacher: async () => Promise.reject(new Error("fetch failed")) } },
    { name: "the teacher lookup passes the deadline", over: { requireTeacher: never } },
    { name: "the class check passes the deadline", over: { ownsClass: never } },
    // An insert Postgres refuses (a value its enum cast rejects).
    { name: "the insert fails", over: { insertReading: (c, t, draft) => insertReading(c, t, { ...draft, questionMode: "not_a_mode" as never }) } },
  ];
  for (const { name, over } of teacherFailures) {
    const result = await keepingAlive(() =>
      guardCreate(
        (preWrite) => createTeacherReadingWith(classId, teacherInput, preWrite, teacherDeps(over)),
        () => ({ state: readingSaveFailedState(readingFormValues(teacherInput)) }),
        { rethrow: rethrowNext, onError: () => {}, deadlineMs: 300 },
      ),
    );
    check(
      "state" in result && result.state.errors?.form === SAVE_READING_FAILED_MESSAGE && result.state.values?.bodyText === BODY && (await classReadings()) === before,
      `teacher create, ${name}: the form keeps everything, no reading written`,
    );
  }
}

async function fullSelfLearner(prefix: string): Promise<string> {
  const id = await newAccount(prefix, "self_learner");
  const readingId = await rawReading(id, `${prefix} reading`);
  const questions = await readyQuestions(id, readingId);
  await submitSelfAnswers(id, readingId, answersFor(questions), { check: checker(false) });
  await sql`insert into link_fetch_attempts (teacher_id) values (${id})`;
  return id;
}

async function checkDelete() {
  console.log("\n== (f) DELETE (Clerk user.deleted) ==");
  const gone = await fullSelfLearner("test_self_gone");
  const kept = await fullSelfLearner("test_self_kept");
  const goneBefore = await selfCounts(gone);
  const keptBefore = await selfCounts(kept);
  console.log(`before: ${JSON.stringify(goneBefore)}`);
  check(SELF_TABLES.every((t) => goneBefore[t] > 0), "the account has rows in every self-learner table");

  const outcome = await handleClerkEvent({ type: "user.deleted", data: { id: clerkId("test_self_gone"), deleted: true } }, neonExecutor);
  check(outcome === "deleted", `user.deleted: ${outcome}`);
  const goneAfter = await selfCounts(gone);
  const keptAfter = await selfCounts(kept);
  for (const t of SELF_TABLES) {
    check(goneAfter[t] === 0, `${t}: the deleted account's ${goneBefore[t]} rows are gone (now ${goneAfter[t]})`);
    check(keptAfter[t] === keptBefore[t], `${t}: the other account still has ${keptBefore[t]} (now ${keptAfter[t]})`);
  }
  const logs = await one<{ n: number }>(sql`
    select (select count(*)::int from link_fetch_attempts where teacher_id = ${gone})
      + (select count(*)::int from question_generation_attempts where teacher_id = ${gone})
      + (select count(*)::int from teachers where id = ${gone}) as n`);
  check(logs.n === 0, `the account row and its logs are gone too (${logs.n})`);
  const again = await handleClerkEvent({ type: "user.deleted", data: { id: clerkId("test_self_gone"), deleted: true } }, neonExecutor);
  check(again === "already_gone", `a repeat delete succeeds quietly: ${again}`);
  const late = await handleClerkEvent(
    {
      type: "user.created",
      data: { id: clerkId("test_self_gone"), first_name: "Late", email_addresses: [{ id: "idn_1", email_address: "late@example.invalid" }] },
    },
    neonExecutor,
  );
  const [, visit = []] = await neonExecutor(createAccountStatements(clerkId("test_self_gone"), "Late", "late@example.invalid"));
  const back = await one<{ n: number }>(sql`select count(*)::int as n from teachers where clerk_user_id = ${clerkId("test_self_gone")}`);
  check(
    late === "deleted_account" && visit.length === 0 && back.n === 0,
    `a deleted self-learner stays deleted: late user.created ${late}, first visit ${visit.length} rows, ${back.n} rows back`,
  );
}

// Through the webhook's delete (classes, then self-learner readings, then
// the account).
async function cleanup(): Promise<void> {
  let deleted = 0;
  for (const prefix of PREFIXES) {
    deleted += deletedAccountRows(await neonExecutor(deleteTeacherStatements(clerkId(prefix))));
  }
  // The delete lists each test id; take them off again.
  const hashes = PREFIXES.map((p) => hashClerkUserId(clerkId(p)));
  await sql`delete from deleted_clerk_users where clerk_user_hash = any(${hashes})`;
  console.log(`\ncleanup: deleted ${deleted} test accounts (and everything under them)`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}`);
  try {
    await checkRole();
    await checkIsolation();
    await checkAllowance();
    await checkFailedGenerations();
    await checkRateLimitedKeepsSlot();
    await checkSoloFlow();
    await checkLockedAnswers();
    await checkGivenBackChecks();
    await checkRoleAndOwnerAtWrite();
    await checkFailedCreates();
    await checkDelete();
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
  console.error("check-self-learner crashed:", error);
  process.exit(1);
});
