// Checks the teacher gaps PR through the real neon-http driver and the
// real app functions, with a MOCK model (no model calls):
//
// - Every foreign key onto readings is ON DELETE CASCADE (from the
//   catalog), so a reading delete reaches every table under it.
// - Reading delete: removes every row under the reading in every
//   dependent table (counted per table before and after: questions shared
//   and per-student, answers, question_generations, student_question_calls,
//   attempts, effort_checks, challenges, reading_cap_raises) and nothing of
//   another reading in the same class (or the students); another teacher
//   gets not_found with every row intact; a second delete is a quiet
//   success (already_gone).
// - Class settings: the warning's draft count; another teacher can't edit
//   (not_found, nothing changes); a same-grade save (a new name) clears
//   nothing and pins nothing; a grade change clears the shared questions
//   of drafts on the class grade and keeps published readings' and
//   overridden drafts', pins the old grade on published readings with no
//   grade (shared and per-student), leaves published readings with their
//   own grade and drafts with none alone (the draft follows the new grade),
//   and touches no other teacher's class; a later change leaves the pinned
//   grade as it is.
// - Student set cap: --claims parallel first opens (distinct students)
//   past the cap make exactly 150 sets; another teacher can't raise it;
//   --raises concurrent raises leave exactly one reading_cap_raises row
//   and a limit of 300; a second raise is a no-op; then parallel opens
//   past the new cap make exactly 300 in all. The class page's badge
//   reads Full at 150, nothing just after the raise, and Full at 300; the
//   reading page shows full at 300 with no raise button.
// - Teacher delete (the Clerk webhook's user.deleted, through
//   handleClerkEvent): a teacher with a class, students, a published
//   per-student reading with a row in every table under it, RESOLVED
//   challenges (resolved_by set), a cap raise, and their own link and
//   generation logs is deleted; every table has 0 rows of theirs
//   (counted per table) and another teacher's rows are all intact. A
//   repeat delete is already_gone, and a late user.updated after it
//   brings no row back.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-teacher-gaps [flags]
//
// Flags:
//   --raises=20      concurrent cap raises (default 20)
//   --claims=200     parallel opens per cap round (default 200, > 150)
//   --concurrency=20 DB requests in flight for the opens (default 20)
//
// Same host guard and NEON_FETCH_ENDPOINT handling as check-class-limit.ts;
// set CHECK_CLASS_LIMIT_HOST to opt in for one Neon dev branch. Writes
// teachers named test_gaps_<run>, test_gaps_other_<run>,
// test_gaps_gone_<run> and test_gaps_kept_<run> and deletes them (and
// everything under them) at the end. Never run against production.
import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import { countDraftsClearedByGradeChange, updateClassSettings } from "@/lib/classes";
import { deletedAccountRows, deleteTeacherStatements, handleClerkEvent } from "@/lib/clerk-webhook";
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { capView } from "@/lib/reading-cap";
import { deleteReading, getClassCapBadges, getReadingCap, raiseReadingCap } from "@/lib/readings";
import { getOrCreateStudentQuestions, postgresStudentQuestionStore } from "@/lib/student-questions";
import { STUDENT_SETS_PER_READING_LIMIT, STUDENT_SETS_RAISED_LIMIT } from "@/lib/student-questions-core";

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

const RAISES = intFlag("raises", 20);
const CLAIMS = intFlag("claims", 200);
const DB_CONCURRENCY = intFlag("concurrency", 20);
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

// The mock model: instant, always the same set. Never the real model.
const write = async (): Promise<string[]> => PROMPTS;

let teacherId = "";
let otherTeacherId = "";
let codeCount = 0;

async function setup() {
  ({ id: teacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_gaps_${RUN_ID}`}, 'test@example.invalid', 'paid')
    returning id`));
  ({ id: otherTeacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_gaps_other_${RUN_ID}`}, 'other@example.invalid', 'paid')
    returning id`));
}

async function newClass(name: string, grade = "4", owner = teacherId): Promise<string> {
  const code = `G${RUN_ID}${codeCount++}`.toUpperCase();
  return (
    await one<{ id: string }>(sql`
      insert into classes (teacher_id, name, grade_level, join_code)
      values (${owner}, ${name}, ${grade}::grade_level, ${code})
      returning id`)
  ).id;
}

async function newReading(
  classId: string,
  title: string,
  mode: "shared" | "per_student",
  status: "draft" | "published",
  grade: string | null = null,
): Promise<string> {
  return (
    await one<{ id: string }>(sql`
      insert into readings (class_id, title, body_text, grade_level, question_count, question_mode, status)
      values (${classId}, ${title}, ${BODY}, ${grade}::grade_level, ${PROMPTS.length}, ${mode}::question_mode, ${status}::reading_status)
      returning id`)
  ).id;
}

async function newStudents(classId: string, prefix: string, n: number): Promise<string[]> {
  const rows = await sql.query(
    `insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
select $1::uuid, $2::text || i, 'Ro', lower($2::text) || i || ' ro', $3::text || i
from unnest($4::int[]) as i
returning id`,
    [classId, prefix, `gaps_${RUN_ID}_${prefix}_`, Array.from({ length: n }, (_, i) => i)],
  );
  return (rows as Record<string, unknown>[]).map((r) => String(r.id));
}

async function sharedQuestions(readingId: string) {
  await sql.query(
    `insert into questions (reading_id, student_id, position, prompt)
select $1::uuid, null, p.position, p.prompt from unnest($2::int[], $3::text[]) as p(position, prompt)`,
    [readingId, PROMPTS.map((_, i) => i + 1), PROMPTS],
  );
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

// ---------------------------------------------------------------------------
// Foreign keys

async function checkCascades() {
  console.log("\n== FOREIGN KEYS ONTO readings ==");
  const rows = (await sql`
    select conrelid::regclass::text as tbl, confdeltype as action
    from pg_constraint where contype = 'f' and confrelid = 'readings'::regclass
    order by 1`) as { tbl: string; action: string }[];
  console.log(`  ${rows.map((r) => `${r.tbl}:${r.action}`).join(", ")}`);
  check(rows.length === 7, `${rows.length} foreign keys reference readings (want 7)`);
  check(rows.every((r) => r.action === "c"), "every one is ON DELETE CASCADE");
  for (const t of ["questions", "question_generations", "student_question_calls", "attempts", "effort_checks", "challenges", "reading_cap_raises"]) {
    check(rows.some((r) => r.tbl === t), `${t} references readings`);
  }
}

// ---------------------------------------------------------------------------
// Reading delete

const READING_TABLES = [
  "readings",
  "shared_questions",
  "student_questions",
  "answers",
  "question_generations",
  "student_question_calls",
  "attempts",
  "effort_checks",
  "challenges",
  "reading_cap_raises",
] as const;

async function readingCounts(readingId: string): Promise<Record<string, number>> {
  return one<Record<string, number>>(sql`
    select
      (select count(*)::int from readings where id = ${readingId}) as readings,
      (select count(*)::int from questions where reading_id = ${readingId} and student_id is null) as shared_questions,
      (select count(*)::int from questions where reading_id = ${readingId} and student_id is not null) as student_questions,
      (select count(*)::int from answers a join questions q on q.id = a.question_id where q.reading_id = ${readingId}) as answers,
      (select count(*)::int from question_generations where reading_id = ${readingId}) as question_generations,
      (select count(*)::int from student_question_calls where reading_id = ${readingId}) as student_question_calls,
      (select count(*)::int from attempts where reading_id = ${readingId}) as attempts,
      (select count(*)::int from effort_checks where reading_id = ${readingId}) as effort_checks,
      (select count(*)::int from challenges where reading_id = ${readingId}) as challenges,
      (select count(*)::int from reading_cap_raises where reading_id = ${readingId}) as reading_cap_raises`);
}

// Gives a reading a row in every table under it: shared questions (set
// directly), each student's own set (through the app, mock model), a
// failed try with answers, a finished effort check, an open challenge,
// and a cap raise.
async function fillReading(classId: string, readingId: string, students: string[], owner = teacherId) {
  await sharedQuestions(readingId);
  for (const studentId of students) {
    const set = await getOrCreateStudentQuestions(readingId, studentId, { write });
    if (set.status !== "ready") throw new Error(`setup set failed: ${set.status}`);
    const { id: attemptId } = await one<{ id: string }>(sql`
      insert into attempts (student_id, reading_id, try_number, result)
      values (${studentId}, ${readingId}, 1, 'fail') returning id`);
    for (const q of set.questions) {
      await sql`
        insert into answers (attempt_id, question_id, text, ai_pass, ai_feedback)
        values (${attemptId}, ${q.id}, 'idk', false, 'Look at the second paragraph.')`;
    }
    await sql`
      insert into effort_checks (student_id, reading_id, finished_at, outcome)
      values (${studentId}, ${readingId}, now(), 'fail')`;
    await sql`
      insert into challenges (student_id, reading_id, note) values (${studentId}, ${readingId}, 'I really tried.')`;
  }
  const raised = await raiseReadingCap(classId, owner, readingId);
  if (raised.status !== "raised") throw new Error(`setup raise failed: ${raised.status}`);
}

async function checkReadingDelete() {
  console.log("\n== READING DELETE ==");
  const classId = await newClass("Delete check");
  const students = await newStudents(classId, "Del", 2);
  const target = await newReading(classId, "Delete me", "per_student", "published");
  const neighbor = await newReading(classId, "Keep me", "per_student", "published");
  await fillReading(classId, target, students);
  await fillReading(classId, neighbor, students);

  const targetBefore = await readingCounts(target);
  const neighborBefore = await readingCounts(neighbor);
  console.log(`before: target ${JSON.stringify(targetBefore)}`);
  check(READING_TABLES.every((t) => targetBefore[t] > 0), "the target has rows in every table under it");
  check(READING_TABLES.every((t) => neighborBefore[t] > 0), "the neighbor has rows in every table under it");

  const intruder = await deleteReading(classId, otherTeacherId, target);
  check(intruder.status === "not_found", `another teacher's delete: ${intruder.status}`);
  check(JSON.stringify(await readingCounts(target)) === JSON.stringify(targetBefore), "...and every row of the reading is intact");
  const otherClass = await newClass("Other class");
  check(
    (await deleteReading(otherClass, teacherId, target)).status === "already_gone",
    "the owner deleting through a class the reading isn't in: a no-op (already_gone)",
  );
  check(JSON.stringify(await readingCounts(target)) === JSON.stringify(targetBefore), "...and every row is still intact");

  const deleted = await deleteReading(classId, teacherId, target);
  check(deleted.status === "deleted", `the owner's delete: ${deleted.status}`);
  const targetAfter = await readingCounts(target);
  const neighborAfter = await readingCounts(neighbor);
  for (const t of READING_TABLES) {
    check(targetAfter[t] === 0, `${t}: the target's ${targetBefore[t]} rows are gone (now ${targetAfter[t]})`);
    check(neighborAfter[t] === neighborBefore[t], `${t}: the neighbor still has ${neighborBefore[t]} (now ${neighborAfter[t]})`);
  }
  const left = await one<{ n: number }>(sql`select count(*)::int as n from students where class_id = ${classId}`);
  check(left.n === students.length, `the class's ${students.length} students stay`);
  const again = await Promise.all([deleteReading(classId, teacherId, target), deleteReading(classId, teacherId, target)]);
  check(again.every((r) => r.status === "already_gone"), `deleting again (twice at once): quiet success (${again.map((r) => r.status).join(", ")})`);
  check((await deleteReading(classId, otherTeacherId, target)).status === "not_found", "another teacher deleting the gone id: still not_found");
  check(JSON.stringify(await readingCounts(neighbor)) === JSON.stringify(neighborBefore), "...and the neighbor is still intact");
}

// ---------------------------------------------------------------------------
// Class settings

async function sharedCount(readingId: string): Promise<number> {
  return (
    await one<{ n: number }>(sql`
      select count(*)::int as n from questions where reading_id = ${readingId} and student_id is null`)
  ).n;
}

// A reading's own grade (null when it follows the class) and the grade
// it's used at.
async function readingGrade(readingId: string) {
  return one<{ own: string | null; effective: string }>(sql`
    select r.grade_level as own, coalesce(r.grade_level, c.grade_level) as effective
    from readings r join classes c on c.id = r.class_id where r.id = ${readingId}`);
}

async function classRow(classId: string) {
  return one<{ name: string; grade_level: string }>(sql`select name, grade_level from classes where id = ${classId}`);
}

async function checkClassSettings() {
  console.log("\n== CLASS SETTINGS ==");
  const classId = await newClass("Room 12", "4");
  const follows = await newReading(classId, "Draft on the class grade", "shared", "draft");
  const own = await newReading(classId, "Draft with its own grade", "shared", "draft", "8");
  const published = await newReading(classId, "Published", "shared", "published");
  const empty = await newReading(classId, "Draft with no questions", "shared", "draft");
  const publishedOwn = await newReading(classId, "Published with its own grade", "shared", "published", "7");
  const perStudent = await newReading(classId, "Published per-student", "per_student", "published");
  for (const r of [follows, own, published, publishedOwn]) await sharedQuestions(r);
  void empty;
  const otherClass = await newClass("Other teacher's room", "4", otherTeacherId);
  const otherPublished = await newReading(otherClass, "Other teacher's published", "per_student", "published");
  const grades = async () =>
    JSON.stringify(
      await Promise.all([follows, own, published, publishedOwn, perStudent, otherPublished].map((r) => readingGrade(r))),
    );
  const gradesBefore = await grades();

  check((await countDraftsClearedByGradeChange(classId, teacherId)) === 1, "the warning counts 1 draft that would be cleared");
  check((await countDraftsClearedByGradeChange(classId, otherTeacherId)) === 0, "another teacher's count is 0");

  const intruder = await updateClassSettings(classId, otherTeacherId, { name: "Hijacked", gradeLevel: "6" });
  check(intruder.status === "not_found", `another teacher's save: ${intruder.status}`);
  const unchanged = await classRow(classId);
  check(unchanged.name === "Room 12" && unchanged.grade_level === "4", "...and the class is unchanged");
  check((await sharedCount(follows)) === 3, "...and no questions were cleared");
  check((await grades()) === gradesBefore, "...and no reading's grade changed");

  const rename = await updateClassSettings(classId, teacherId, { name: "Room 12B", gradeLevel: "4" });
  check(rename.status === "saved" && rename.clearedDrafts === 0, `same-grade save: ${JSON.stringify(rename)}`);
  const renamed = await classRow(classId);
  check(renamed.name === "Room 12B" && renamed.grade_level === "4", "...the name changed, the grade didn't");
  check((await sharedCount(follows)) === 3 && (await sharedCount(own)) === 3 && (await sharedCount(published)) === 3, "...and nothing was cleared");
  check((await grades()) === gradesBefore, `...and nothing was pinned: ${await grades()}`);

  const change = await updateClassSettings(classId, teacherId, { name: "Room 12B", gradeLevel: "6" });
  check(change.status === "saved" && change.clearedDrafts === 1, `grade change 4 -> 6: ${JSON.stringify(change)}`);
  check((await classRow(classId)).grade_level === "6", "...the grade is 6");
  check((await sharedCount(follows)) === 0, "...the draft on the class grade lost its questions");
  check((await sharedCount(own)) === 3, "...the draft with its own grade kept them");
  check((await sharedCount(published)) === 3, "...the published reading kept them");
  check((await countDraftsClearedByGradeChange(classId, teacherId)) === 0, "...and the warning now counts 0");

  const pinned = await readingGrade(published);
  check(
    pinned.own === "4" && pinned.effective === "4",
    `...the published reading with no grade got the old grade pinned: ${JSON.stringify(pinned)}`,
  );
  const pinnedPer = await readingGrade(perStudent);
  check(
    pinnedPer.own === "4" && pinnedPer.effective === "4",
    `...so did the published per-student one (its new sets stay grade 4): ${JSON.stringify(pinnedPer)}`,
  );
  const kept = await readingGrade(publishedOwn);
  check(kept.own === "7" && kept.effective === "7", `...the published reading with its own grade is untouched: ${JSON.stringify(kept)}`);
  const draft = await readingGrade(follows);
  check(draft.own === null && draft.effective === "6", `...the draft with no grade still follows the class: ${JSON.stringify(draft)}`);
  const ownDraft = await readingGrade(own);
  check(ownDraft.own === "8", `...the draft with its own grade keeps it: ${JSON.stringify(ownDraft)}`);
  const other = await readingGrade(otherPublished);
  check(
    other.own === null && other.effective === "4" && (await classRow(otherClass)).grade_level === "4",
    `...and another teacher's class and reading are untouched: ${JSON.stringify(other)}`,
  );

  const again = await updateClassSettings(classId, teacherId, { name: "Room 12B", gradeLevel: "8" });
  check(again.status === "saved", `another change 6 -> 8: ${JSON.stringify(again)}`);
  const still = await readingGrade(published);
  check(still.own === "4" && still.effective === "4", `...the pinned reading stays at grade 4: ${JSON.stringify(still)}`);
  check((await readingGrade(follows)).effective === "8", "...and the draft follows to 8");
}

// ---------------------------------------------------------------------------
// Student set cap and its raise

async function claims(readingId: string): Promise<number> {
  return (await one<{ n: number }>(sql`select count(*)::int as n from question_generations where reading_id = ${readingId}`)).n;
}

async function setsSaved(readingId: string): Promise<number> {
  return (
    await one<{ n: number }>(sql`
      select count(distinct student_id)::int as n from questions where reading_id = ${readingId} and student_id is not null`)
  ).n;
}

async function openAll(readingId: string, students: string[]) {
  const store = postgresStudentQuestionStore(throttled(DB_CONCURRENCY));
  const settled = await Promise.allSettled(students.map((s) => getOrCreateStudentQuestions(readingId, s, { write, store })));
  const statuses: Record<string, number> = {};
  for (const r of settled) {
    const key = r.status === "fulfilled" ? r.value.status : "threw";
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  return statuses;
}

async function checkCap() {
  const from = STUDENT_SETS_PER_READING_LIMIT;
  const to = STUDENT_SETS_RAISED_LIMIT;
  console.log(`\n== STUDENT SET CAP: ${CLAIMS} parallel opens, cap ${from}; ${RAISES} concurrent raises to ${to} ==`);
  const classId = await newClass("Cap check");
  const readingId = await newReading(classId, "Cap reading", "per_student", "published");
  const sharedReading = await newReading(classId, "Shared reading", "shared", "published");
  const total = Math.max(CLAIMS, to - from) + to;
  const students = await newStudents(classId, "Cap", total);

  const first = await openAll(readingId, students.slice(0, CLAIMS));
  console.log(`  round 1: ${JSON.stringify(first)}`);
  check((first.ready ?? 0) === from && (first.limit_reached ?? 0) === CLAIMS - from, `exactly ${from} sets, the rest limit_reached`);
  check((await claims(readingId)) === from && (await setsSaved(readingId)) === from, `${from} claims and ${from} saved sets`);
  const capBefore = await getReadingCap(classId, teacherId, readingId);
  check(JSON.stringify(capBefore) === JSON.stringify({ used: from, limit: from, raised: false }), `the page sees full: ${JSON.stringify(capBefore)}`);
  const badgesFull = await getClassCapBadges(classId, teacherId);
  check(
    badgesFull.size === 1 && JSON.stringify(badgesFull.get(readingId)) === JSON.stringify({ level: "full", used: from, limit: from }),
    `the class page badges it Full: ${JSON.stringify([...badgesFull])}`,
  );
  check((await getClassCapBadges(classId, otherTeacherId)).size === 0, "another teacher sees no badges for the class");

  const intruder = await raiseReadingCap(classId, otherTeacherId, readingId);
  check(intruder.status === "not_found", `another teacher's raise: ${intruder.status}`);
  check((await getReadingCap(classId, otherTeacherId, readingId)) === undefined, "another teacher can't read the cap");
  check((await raiseReadingCap(classId, teacherId, sharedReading)).status === "not_found", "a shared reading has no cap to raise");
  const noRows = await one<{ n: number }>(sql`select count(*)::int as n from reading_cap_raises where reading_id = ${readingId}`);
  check(noRows.n === 0, "...and no raise was logged");

  const settled = await Promise.allSettled(Array.from({ length: RAISES }, () => raiseReadingCap(classId, teacherId, readingId)));
  const thrown = settled.filter((r) => r.status === "rejected").length;
  const results = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value.status] : []));
  check(thrown === 0, `${RAISES} concurrent raises, none threw (${thrown} threw)`);
  check(
    results.filter((s) => s === "raised").length === 1 && results.filter((s) => s === "already_raised").length === RAISES - 1,
    `exactly one raised, ${RAISES - 1} already_raised`,
  );
  const log = (await sql`
    select teacher_id, from_limit, to_limit from reading_cap_raises where reading_id = ${readingId}`) as {
    teacher_id: string;
    from_limit: number;
    to_limit: number;
  }[];
  check(log.length === 1, `exactly one log row (got ${log.length})`);
  check(log[0]?.teacher_id === teacherId && log[0]?.from_limit === from && log[0]?.to_limit === to, `the log: ${from} -> ${to} by the owner`);
  check((await getClassCapBadges(classId, teacherId)).size === 0, `after the raise (${from} of ${to}) the class page shows no badge`);
  const second = await raiseReadingCap(classId, teacherId, readingId);
  check(second.status === "already_raised" && second.limit === to, `a second raise is a no-op: ${JSON.stringify(second)}`);
  check(
    (await one<{ n: number }>(sql`select count(*)::int as n from reading_cap_raises where reading_id = ${readingId}`)).n === 1,
    "...still one log row",
  );

  // Every student at once: the 150 with a set, the ones turned away, and
  // enough new ones to pass 300.
  const next = await openAll(readingId, students);
  console.log(`  round 2 (${students.length} opens): ${JSON.stringify(next)}`);
  check(
    (next.ready ?? 0) === to && (next.limit_reached ?? 0) === students.length - to,
    `exactly ${to} ready (${from} kept, ${to - from} new), the rest limit_reached`,
  );
  check((await claims(readingId)) === to && (await setsSaved(readingId)) === to, `${to} claims and ${to} saved sets in all, never over`);
  const repeat = await openAll(readingId, students.slice(0, 10));
  check((repeat.ready ?? 0) === 10, "students who have a set still get it at the new cap");
  const capAfter = await getReadingCap(classId, teacherId, readingId);
  check(JSON.stringify(capAfter) === JSON.stringify({ used: to, limit: to, raised: true }), `the page sees the new limit: ${JSON.stringify(capAfter)}`);
  check(capAfter !== undefined && capView(capAfter).kind === "raised_full", "...and shows it full at the new limit, with no button");
  const badgesAfter = await getClassCapBadges(classId, teacherId);
  check(
    JSON.stringify(badgesAfter.get(readingId)) === JSON.stringify({ level: "full", used: to, limit: to }),
    `the class page badges it Full at ${to}: ${JSON.stringify([...badgesAfter])}`,
  );
}

// ---------------------------------------------------------------------------
// Teacher delete (the Clerk webhook's user.deleted)

const TEACHER_TABLES = [
  "teachers",
  "classes",
  "students",
  "readings",
  "questions",
  "attempts",
  "answers",
  "challenges",
  "resolved_challenges",
  "effort_checks",
  "question_generations",
  "student_question_calls",
  "reading_cap_raises",
  "link_fetch_attempts",
  "question_generation_attempts",
] as const;

type Owned = { teacherId: string; classIds: string[]; readingIds: string[]; studentIds: string[] };

// Counted by the ids taken before the delete, not through the classes
// (which would read 0 once the classes are gone, whatever is left).
async function teacherCounts(o: Owned): Promise<Record<string, number>> {
  return one<Record<string, number>>(sql`
    select
      (select count(*)::int from teachers where id = ${o.teacherId}) as teachers,
      (select count(*)::int from classes where id = any(${o.classIds}::uuid[]) or teacher_id = ${o.teacherId}) as classes,
      (select count(*)::int from students where id = any(${o.studentIds}::uuid[]) or class_id = any(${o.classIds}::uuid[])) as students,
      (select count(*)::int from readings where id = any(${o.readingIds}::uuid[]) or class_id = any(${o.classIds}::uuid[])) as readings,
      (select count(*)::int from questions where reading_id = any(${o.readingIds}::uuid[]) or student_id = any(${o.studentIds}::uuid[])) as questions,
      (select count(*)::int from attempts where reading_id = any(${o.readingIds}::uuid[]) or student_id = any(${o.studentIds}::uuid[])) as attempts,
      (select count(*)::int from answers a join attempts t on t.id = a.attempt_id where t.student_id = any(${o.studentIds}::uuid[])) as answers,
      (select count(*)::int from challenges where reading_id = any(${o.readingIds}::uuid[]) or student_id = any(${o.studentIds}::uuid[]) or resolved_by = ${o.teacherId}) as challenges,
      (select count(*)::int from challenges where resolved_by = ${o.teacherId}) as resolved_challenges,
      (select count(*)::int from effort_checks where reading_id = any(${o.readingIds}::uuid[]) or student_id = any(${o.studentIds}::uuid[])) as effort_checks,
      (select count(*)::int from question_generations where reading_id = any(${o.readingIds}::uuid[]) or student_id = any(${o.studentIds}::uuid[])) as question_generations,
      (select count(*)::int from student_question_calls where reading_id = any(${o.readingIds}::uuid[]) or student_id = any(${o.studentIds}::uuid[])) as student_question_calls,
      (select count(*)::int from reading_cap_raises where reading_id = any(${o.readingIds}::uuid[]) or teacher_id = ${o.teacherId}) as reading_cap_raises,
      (select count(*)::int from link_fetch_attempts where teacher_id = ${o.teacherId}) as link_fetch_attempts,
      (select count(*)::int from question_generation_attempts where teacher_id = ${o.teacherId}) as question_generation_attempts`);
}

// A teacher with a class, students, a published per-student reading with
// a row in every table under it, challenges they RESOLVED (resolved_by
// set: the case a single "delete from teachers" fails on), a cap raise,
// and their own link and generation logs.
async function fullTeacher(clerkUserId: string, prefix: string): Promise<Owned> {
  const { id } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${clerkUserId}, 'gone@example.invalid', 'paid')
    returning id`);
  const classId = await newClass(`${prefix} class`, "4", id);
  const studentIds = await newStudents(classId, prefix, 2);
  const readingId = await newReading(classId, `${prefix} reading`, "per_student", "published");
  await fillReading(classId, readingId, studentIds, id);
  await sql`
    update challenges set status = 'approved', resolved_at = now(), resolved_by = ${id}
    where reading_id = ${readingId}`;
  await sql`insert into link_fetch_attempts (teacher_id) values (${id})`;
  await sql`insert into question_generation_attempts (teacher_id) values (${id})`;
  return { teacherId: id, classIds: [classId], readingIds: [readingId], studentIds };
}

async function checkTeacherDelete() {
  console.log("\n== TEACHER DELETE (Clerk user.deleted) ==");
  const goneClerkId = `test_gaps_gone_${RUN_ID}`;
  const keptClerkId = `test_gaps_kept_${RUN_ID}`;
  const gone = await fullTeacher(goneClerkId, "Gone");
  const kept = await fullTeacher(keptClerkId, "Kept");

  const goneBefore = await teacherCounts(gone);
  const keptBefore = await teacherCounts(kept);
  console.log(`before: ${JSON.stringify(goneBefore)}`);
  check(TEACHER_TABLES.every((t) => goneBefore[t] > 0), "the teacher has rows in every table, resolved challenges included");
  check(TEACHER_TABLES.every((t) => keptBefore[t] > 0), "so does the other teacher");

  let outcome: string;
  try {
    outcome = await handleClerkEvent({ type: "user.deleted", data: { id: goneClerkId, deleted: true } }, neonExecutor);
  } catch (error) {
    const { code } = error as { code?: unknown };
    outcome = `threw ${String(code)}`;
  }
  check(outcome === "deleted", `user.deleted: ${outcome}`);
  const goneAfter = await teacherCounts(gone);
  const keptAfter = await teacherCounts(kept);
  for (const t of TEACHER_TABLES) {
    check(goneAfter[t] === 0, `${t}: the deleted teacher's ${goneBefore[t]} rows are gone (now ${goneAfter[t]})`);
    check(keptAfter[t] === keptBefore[t], `${t}: the other teacher still has ${keptBefore[t]} (now ${keptAfter[t]})`);
  }

  const again = await Promise.all([
    handleClerkEvent({ type: "user.deleted", data: { id: goneClerkId, deleted: true } }, neonExecutor),
    handleClerkEvent({ type: "user.deleted", data: { id: goneClerkId, deleted: true } }, neonExecutor),
  ]);
  check(again.every((r) => r === "already_gone"), `a repeat delete (twice at once): ${again.join(", ")}`);

  const late = await handleClerkEvent(
    {
      type: "user.updated",
      data: { id: goneClerkId, first_name: "Late", email_addresses: [{ id: "idn_1", email_address: "late@example.invalid" }] },
    },
    neonExecutor,
  );
  check(late === "no_teacher", `a late user.updated after user.deleted: ${late}`);
  const rows = await one<{ n: number }>(sql`select count(*)::int as n from teachers where clerk_user_id = ${goneClerkId}`);
  check(rows.n === 0, `...and no teacher row came back (${rows.n})`);
  check(JSON.stringify(await teacherCounts(kept)) === JSON.stringify(keptBefore), "...and the other teacher is still intact");

  const renamed = await handleClerkEvent(
    { type: "user.updated", data: { id: keptClerkId, first_name: "Kept", last_name: "Fake", email_addresses: [{ id: "idn_1", email_address: "kept@example.invalid" }] } },
    neonExecutor,
  );
  const keptRow = await one<{ name: string; email: string }>(sql`select name, email from teachers where id = ${kept.teacherId}`);
  check(
    renamed === "updated" && keptRow.name === "Kept Fake" && keptRow.email === "kept@example.invalid",
    `user.updated for a live teacher updates the row: ${renamed}`,
  );
}

// ---------------------------------------------------------------------------

// Through the webhook's delete (classes first), so a resolved challenge
// left by a failed run can't block it.
async function cleanup(): Promise<void> {
  let deleted = 0;
  for (const prefix of ["test_gaps", "test_gaps_other", "test_gaps_gone", "test_gaps_kept"]) {
    const results = await neonExecutor(deleteTeacherStatements(`${prefix}_${RUN_ID}`));
    deleted += deletedAccountRows(results);
  }
  console.log(`\ncleanup: deleted ${deleted} test teachers (and everything under them)`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}`);
  try {
    await setup();
    await checkCascades();
    await checkReadingDelete();
    await checkClassSettings();
    await checkCap();
    await checkTeacherDelete();
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
  console.error("check-teacher-gaps crashed:", error);
  process.exit(1);
});
