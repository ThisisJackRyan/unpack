// Checks the teacher gaps PR through the real neon-http driver and the
// real app functions, with a MOCK model (no Anthropic calls):
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
//   nothing; a grade change clears the shared questions of drafts on the
//   class grade and keeps published readings' and overridden drafts'.
// - Student set cap: --claims parallel first opens (distinct students)
//   past the cap make exactly 150 sets; another teacher can't raise it;
//   --raises concurrent raises leave exactly one reading_cap_raises row
//   and a limit of 300; a second raise is a no-op; then parallel opens
//   past the new cap make exactly 300 in all.
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
// teachers named test_gaps_<run> and test_gaps_other_<run> and deletes
// them (and everything under them, by cascade) at the end. Never run
// against production.
import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import { countDraftsClearedByGradeChange, updateClassSettings } from "@/lib/classes";
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { deleteReading, getReadingCap, raiseReadingCap } from "@/lib/readings";
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
// code path could reach Anthropic with a real key.
delete process.env.ANTHROPIC_API_KEY;
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

// The mock model: instant, always the same set. Never Anthropic.
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

async function newClass(name: string, grade = "4"): Promise<string> {
  const code = `G${RUN_ID}${codeCount++}`.toUpperCase();
  return (
    await one<{ id: string }>(sql`
      insert into classes (teacher_id, name, grade_level, join_code)
      values (${teacherId}, ${name}, ${grade}::grade_level, ${code})
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
async function fillReading(classId: string, readingId: string, students: string[]) {
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
  const raised = await raiseReadingCap(classId, teacherId, readingId);
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
  for (const r of [follows, own, published]) await sharedQuestions(r);
  void empty;

  check((await countDraftsClearedByGradeChange(classId, teacherId)) === 1, "the warning counts 1 draft that would be cleared");
  check((await countDraftsClearedByGradeChange(classId, otherTeacherId)) === 0, "another teacher's count is 0");

  const intruder = await updateClassSettings(classId, otherTeacherId, { name: "Hijacked", gradeLevel: "6" });
  check(intruder.status === "not_found", `another teacher's save: ${intruder.status}`);
  const unchanged = await classRow(classId);
  check(unchanged.name === "Room 12" && unchanged.grade_level === "4", "...and the class is unchanged");
  check((await sharedCount(follows)) === 3, "...and no questions were cleared");

  const rename = await updateClassSettings(classId, teacherId, { name: "Room 12B", gradeLevel: "4" });
  check(rename.status === "saved" && rename.clearedDrafts === 0, `same-grade save: ${JSON.stringify(rename)}`);
  const renamed = await classRow(classId);
  check(renamed.name === "Room 12B" && renamed.grade_level === "4", "...the name changed, the grade didn't");
  check((await sharedCount(follows)) === 3 && (await sharedCount(own)) === 3 && (await sharedCount(published)) === 3, "...and nothing was cleared");

  const change = await updateClassSettings(classId, teacherId, { name: "Room 12B", gradeLevel: "6" });
  check(change.status === "saved" && change.clearedDrafts === 1, `grade change 4 -> 6: ${JSON.stringify(change)}`);
  check((await classRow(classId)).grade_level === "6", "...the grade is 6");
  check((await sharedCount(follows)) === 0, "...the draft on the class grade lost its questions");
  check((await sharedCount(own)) === 3, "...the draft with its own grade kept them");
  check((await sharedCount(published)) === 3, "...the published reading kept them");
  check((await countDraftsClearedByGradeChange(classId, teacherId)) === 0, "...and the warning now counts 0");
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
}

// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id = any(${[`test_gaps_${RUN_ID}`, `test_gaps_other_${RUN_ID}`]}::text[])
    returning id`;
  console.log(`\ncleanup: deleted ${rows.length} test teachers (and everything under them)`);
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
