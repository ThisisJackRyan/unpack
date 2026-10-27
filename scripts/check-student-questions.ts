// Checks the question generation race guards through the real neon-http
// driver and the real app functions, with a MOCK model (no model calls):
//
// - getOrCreateStudentQuestions: parallel first opens call the model once
//   per student and save exactly question_count rows, positions 1..N; a
//   stale claim is taken over (and the old holder can't save); a failed
//   model call releases the claim; a student from another class is
//   "not_allowed".
// - The per-reading cap: --cap-students parallel first opens by distinct
//   students on one reading -> exactly STUDENT_SETS_PER_READING_LIMIT sets,
//   the rest "limit_reached".
// - The teacher generation rate limit: 40 parallel -> exactly 30.
// - Shared questions: generate, delete with renumbering, the last-question
//   rule, edit-page clearing, publish, the lock after publish, and title-only
//   edits after publish.
// - updateClassSettings (the grade change): clears only drafts that follow
//   the class grade.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-student-questions [flags]
//
// Flags:
//   --n=15         parallel opens per student per round (default 15)
//   --rounds=3     rounds (default 3)
//   --students=3   students (default 3)
//   --cap-students=200  distinct students in the cap race (default 200)
//   --cap-rounds=1      cap race rounds, each on a fresh reading (default 1)
//   --db-concurrency=60 most DB requests in flight in the cap race (default
//                       60). All opens start at once; this only keeps a
//                       local Postgres (max_connections 100, one connection
//                       per proxied request) from refusing connections.
//                       Neon's pooler doesn't need it.
//
// Same host guard and NEON_FETCH_ENDPOINT handling as check-class-limit.ts;
// set CHECK_CLASS_LIMIT_HOST to opt in for one Neon dev branch. Writes a
// teacher named test_questions_<run> and deletes it (and everything under
// it, by cascade) at the end. Never run against production.
import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { neonExecutor } from "@/lib/neon-executor";
import { recordQuestionGeneration } from "@/lib/question-generation-attempts";
import { QUESTION_GENERATION_LIMIT } from "@/lib/question-rate-limit";
import {
  bodyMd5,
  deleteSharedQuestion,
  listSharedQuestions,
  publishReading,
  saveQuestionSet,
  updateSharedQuestion,
} from "@/lib/shared-questions-db";
import { updateClassSettings } from "@/lib/classes";
import { saveReadingEdit } from "@/lib/readings";
import type { ReadingRef } from "@/lib/shared-questions";
import {
  getOrCreateStudentQuestions,
  postgresStudentQuestionStore,
} from "@/lib/student-questions";
import {
  CLAIM_STALE_SECONDS,
  STUDENT_SETS_PER_READING_LIMIT,
} from "@/lib/student-questions-core";

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

const N = intFlag("n", 15);
const ROUNDS = intFlag("rounds", 3);
const STUDENTS = intFlag("students", 3);
const CAP_STUDENTS = intFlag("cap-students", 200);
const CAP_ROUNDS = intFlag("cap-rounds", 1);
const DB_CONCURRENCY = intFlag("db-concurrency", 60);
const COUNT = 3;
const RUN_ID = Math.random().toString(36).slice(2, 10);
const BODY = "Mia walked to the river after the storm and found a fox. ".repeat(10);
// Quotes, commas, braces, and backslashes, to check array params survive.
const TRICKY = ['Why did "Mia" go, {really}?', "What did the fox do \\ next?", "What do you think, and why?"];

const sql = getSql();
const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

// Mock model: counts calls per student, takes a moment like a real call.
const modelCalls = new Map<string, number>();
function mockWriter(studentId: string, fail = false) {
  return async () => {
    modelCalls.set(studentId, (modelCalls.get(studentId) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (fail) throw new Error("mock model failure");
    return TRICKY;
  };
}

// The real Postgres store, counting claim outcomes, to show the opens really
// contended (losers that never called the model).
const claimStats = { won: 0, lost: 0 };
const baseStore = postgresStudentQuestionStore();
const countingStore = {
  ...baseStore,
  async claim(r: string, s: string, t: string, limit: number) {
    const outcome = await baseStore.claim(r, s, t, limit);
    claimStats[outcome === "claimed" ? "won" : "lost"]++;
    return outcome;
  },
};

async function one<T>(query: Promise<Record<string, unknown>[]>): Promise<T> {
  return (await query)[0] as T;
}

let teacherId = "";
let classId = "";

async function setup(): Promise<{ readingId: string; students: string[]; otherStudent: string; draftId: string }> {
  ({ id: teacherId } = await one<{ id: string }>(sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${`test_questions_${RUN_ID}`}, 'test@example.invalid', 'paid')
    returning id`));
  ({ id: classId } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Questions check', '4', ${`QC${RUN_ID}`.toUpperCase().slice(0, 8)})
    returning id`));
  const { id: otherClass } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Other class', '4', ${`QO${RUN_ID}`.toUpperCase().slice(0, 8)})
    returning id`);
  const { id: readingId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Per-student check', ${BODY}, ${COUNT}, 'per_student', 'published')
    returning id`);
  const { id: draftId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Draft per-student', ${BODY}, ${COUNT}, 'per_student', 'draft')
    returning id`);
  const students: string[] = [];
  for (let i = 0; i < STUDENTS + 3; i++) {
    const { id } = await one<{ id: string }>(sql`
      insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
      values (${classId}, ${`Kid${i}`}, 'Q', ${`kid${i} q`}, ${`hash_${RUN_ID}_${i}`})
      returning id`);
    students.push(id);
  }
  const { id: otherStudent } = await one<{ id: string }>(sql`
    insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
    values (${otherClass}, 'Other', 'Q', 'other q', ${`hash_${RUN_ID}_other`})
    returning id`);
  return { readingId, students, otherStudent, draftId };
}

async function studentRows(readingId: string, studentId: string): Promise<number[]> {
  const rows = await sql`
    select position from questions where reading_id = ${readingId} and student_id = ${studentId}
    order by position`;
  return rows.map((r) => Number(r.position));
}

async function checkStudentRaces(readingId: string, students: string[]) {
  console.log(`\n== PER-STUDENT: ${ROUNDS} rounds x ${students.length} students x ${N} parallel opens ==`);
  const statusCounts: Record<string, number> = {};
  const thrown: string[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const settled = await Promise.allSettled(
      students.flatMap((s) =>
        Array.from({ length: N }, () =>
          getOrCreateStudentQuestions(readingId, s, { write: mockWriter(s), store: countingStore }),
        ),
      ),
    );
    for (const r of settled) {
      if (r.status === "rejected") thrown.push(String((r.reason as Error)?.message));
      else statusCounts[r.value.status] = (statusCounts[r.value.status] ?? 0) + 1;
    }
    console.log(`after round ${round}: results so far ${JSON.stringify(statusCounts)}`);
  }
  console.log(`claims won ${claimStats.won}, lost ${claimStats.lost} (losers never call the model)`);
  check(claimStats.won === students.length, `claims won = ${claimStats.won} (want ${students.length})`);
  check(thrown.length === 0, `no errors thrown (${thrown.length})`);
  for (const s of students) {
    const calls = modelCalls.get(s) ?? 0;
    const positions = await studentRows(readingId, s);
    check(calls === 1, `student ${s.slice(0, 8)}: model calls = ${calls} (want 1)`);
    check(
      positions.join(",") === "1,2,3",
      `student ${s.slice(0, 8)}: rows = ${positions.length}, positions [${positions.join(",")}] (want 1..${COUNT})`,
    );
    const final = await getOrCreateStudentQuestions(readingId, s, { write: mockWriter(s) });
    check(
      final.status === "ready" && final.questions.map((q) => q.prompt).join("|") === TRICKY.join("|"),
      `student ${s.slice(0, 8)}: later open returns the cached set unchanged`,
    );
  }
  check(
    students.every((s) => modelCalls.get(s) === 1),
    "no extra model calls after the set was cached",
  );
}

async function checkStaleTakeover(readingId: string, studentId: string) {
  console.log(`\n== STALE CLAIM TAKEOVER (stale after ${CLAIM_STALE_SECONDS}s) ==`);
  const fresh = "00000000-0000-4000-8000-0000000000f1";
  await sql`
    insert into question_generations (reading_id, student_id, claim_token)
    values (${readingId}, ${studentId}, ${fresh})`;
  const pending = await getOrCreateStudentQuestions(readingId, studentId, { write: mockWriter(studentId) });
  check(
    pending.status === "pending" && !modelCalls.get(studentId),
    `fresh pending claim: result ${pending.status}, model calls ${modelCalls.get(studentId) ?? 0}`,
  );

  await sql`
    update question_generations
    set claimed_at = now() - make_interval(secs => ${CLAIM_STALE_SECONDS + 5})
    where reading_id = ${readingId} and student_id = ${studentId}`;
  const settled = await Promise.all(
    Array.from({ length: 10 }, () =>
      getOrCreateStudentQuestions(readingId, studentId, { write: mockWriter(studentId) }),
    ),
  );
  const calls = modelCalls.get(studentId) ?? 0;
  const claim = await one<{ status: string; claim_token: string }>(sql`
    select status, claim_token from question_generations
    where reading_id = ${readingId} and student_id = ${studentId}`);
  check(calls === 1, `stale claim, 10 parallel opens: model calls = ${calls} (want 1)`);
  check(
    settled.some((r) => r.status === "ready") && claim.status === "done" && claim.claim_token !== fresh,
    `taken over: claim now ${claim.status} with a new token`,
  );
  const lateCommit = await postgresStudentQuestionStore().commit(readingId, studentId, fresh, ["X?", "Y?", "Z?"]);
  const positions = await studentRows(readingId, studentId);
  check(
    !lateCommit && positions.join(",") === "1,2,3",
    `old holder's late commit refused (${lateCommit}); rows still [${positions.join(",")}]`,
  );
}

async function checkFailureReleases(readingId: string, studentId: string) {
  console.log("\n== MODEL FAILURE RELEASES THE CLAIM ==");
  const failed = await getOrCreateStudentQuestions(readingId, studentId, { write: mockWriter(studentId, true) });
  const claims = await sql`
    select 1 from question_generations where reading_id = ${readingId} and student_id = ${studentId}`;
  check(
    failed.status === "error" && claims.length === 0 && (await studentRows(readingId, studentId)).length === 0,
    `failed call: result ${failed.status}${failed.status === "error" ? ` (${failed.kind})` : ""}, claims left ${claims.length}, rows 0`,
  );
  const retry = await getOrCreateStudentQuestions(readingId, studentId, { write: mockWriter(studentId) });
  check(
    retry.status === "ready" && modelCalls.get(studentId) === 2,
    `next open writes the set: ${retry.status}, model calls ${modelCalls.get(studentId)} (1 failed + 1 ok)`,
  );
}

async function checkNotFound(readingId: string, draftId: string, otherStudent: string, student: string) {
  console.log("\n== NOT FOUND / NOT ALLOWED CASES ==");
  const a = await getOrCreateStudentQuestions(readingId, otherStudent, { write: mockWriter(otherStudent) });
  const b = await getOrCreateStudentQuestions(draftId, student, { write: mockWriter(student) });
  check(a.status === "not_allowed", `student from another class: ${a.status} (want not_allowed)`);
  check(b.status === "not_found", `draft reading: ${b.status}`);
  check(!modelCalls.get(otherStudent), "no model call for not_allowed");
  // The claim's own class check, even if the load check were skipped.
  const claim = await baseStore.claim(readingId, otherStudent, "00000000-0000-4000-8000-0000000000c1", STUDENT_SETS_PER_READING_LIMIT);
  const rows = await sql`
    select 1 from question_generations where reading_id = ${readingId} and student_id = ${otherStudent}`;
  check(claim === "refused" && rows.length === 0, `direct claim for another class's student: ${claim}, rows ${rows.length}`);
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

async function checkCap() {
  const limit = STUDENT_SETS_PER_READING_LIMIT;
  console.log(
    `\n== PER-READING CAP: ${CAP_ROUNDS} round(s) x ${CAP_STUDENTS} distinct students at once, cap ${limit}, ` +
      `${DB_CONCURRENCY} DB requests in flight ==`,
  );
  const store = postgresStudentQuestionStore(throttled(DB_CONCURRENCY));
  let maxWaiting = 0;
  let waitingNow = 0;
  const capStore = {
    ...store,
    // Counts opens waiting on a claim at once, to show they contended.
    async claim(r: string, s: string, t: string, l: number) {
      maxWaiting = Math.max(maxWaiting, ++waitingNow);
      try {
        return await store.claim(r, s, t, l);
      } finally {
        waitingNow--;
      }
    },
  };
  const students: string[] = [];
  const values = Array.from({ length: CAP_STUDENTS }, (_, i) => i);
  const rows = await sql.query(
    `insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
select $1::uuid, 'Cap' || i, 'Z', 'cap' || i || ' z', $2::text || i
from unnest($3::int[]) as i
returning id`,
    [classId, `cap_${RUN_ID}_`, values],
  );
  for (const r of rows as Record<string, unknown>[]) students.push(String(r.id));
  const wantLimited = Math.max(0, CAP_STUDENTS - limit);
  const wantSets = Math.min(CAP_STUDENTS, limit);

  for (let round = 1; round <= CAP_ROUNDS; round++) {
    const { id: readingId } = await one<{ id: string }>(sql`
      insert into readings (class_id, title, body_text, question_count, question_mode, status)
      values (${classId}, ${`Cap check ${round}`}, ${BODY}, ${COUNT}, 'per_student', 'published')
      returning id`);
    let calls = 0;
    const write = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return TRICKY;
    };
    const started = Date.now();
    const settled = await Promise.allSettled(
      students.map((s) => getOrCreateStudentQuestions(readingId, s, { write, store: capStore })),
    );
    const ms = Date.now() - started;
    const statuses: Record<string, number> = {};
    const thrown: string[] = [];
    for (const r of settled) {
      if (r.status === "rejected") thrown.push(String((r.reason as Error)?.message));
      else statuses[r.value.status] = (statuses[r.value.status] ?? 0) + 1;
    }
    const counts = await one<{ claims: number; done: number; sets: number; rows: number }>(sql`
      select
        (select count(*)::int from question_generations where reading_id = ${readingId}) as claims,
        (select count(*)::int from question_generations where reading_id = ${readingId} and status = 'done') as done,
        (select count(distinct student_id)::int from questions where reading_id = ${readingId}) as sets,
        (select count(*)::int from questions where reading_id = ${readingId}) as rows`);
    console.log(
      `round ${round}: ${ms}ms, results ${JSON.stringify(statuses)}, threw ${thrown.length}${thrown.length ? ` (${[...new Set(thrown)].join("; ")})` : ""}, ` +
        `model calls ${calls}, claims ${counts.claims} (done ${counts.done}), sets ${counts.sets}, question rows ${counts.rows}, ` +
        `most claims in flight at once ${maxWaiting}`,
    );
    maxWaiting = 0;
    check(thrown.length === 0, `round ${round}: no errors thrown (${thrown.length})`);
    check(
      (statuses.ready ?? 0) === wantSets && (statuses.limit_reached ?? 0) === wantLimited,
      `round ${round}: ready ${statuses.ready ?? 0}, limit_reached ${statuses.limit_reached ?? 0} (want ${wantSets}/${wantLimited})`,
    );
    check(calls === wantSets, `round ${round}: model calls ${calls} (want ${wantSets})`);
    check(
      counts.claims === wantSets && counts.done === wantSets && counts.sets === wantSets &&
        counts.rows === wantSets * COUNT,
      `round ${round}: claims ${counts.claims}, done ${counts.done}, sets ${counts.sets}, rows ${counts.rows} (want ${wantSets}/${wantSets}/${wantSets}/${wantSets * COUNT})`,
    );

    if (round === 1 && wantLimited > 0) {
      // At the cap: a student with a set still gets it, a refused one stays
      // refused, and neither calls the model.
      const refused = students.find((_, i) => settled[i].status === "fulfilled" &&
        (settled[i] as PromiseFulfilledResult<{ status: string }>).value.status === "limit_reached")!;
      const served = students.find((_, i) => settled[i].status === "fulfilled" &&
        (settled[i] as PromiseFulfilledResult<{ status: string }>).value.status === "ready")!;
      const again = await getOrCreateStudentQuestions(readingId, served, { write });
      const still = await getOrCreateStudentQuestions(readingId, refused, { write });
      check(
        again.status === "ready" && still.status === "limit_reached" && calls === wantSets,
        `at the cap: served student ${again.status}, refused student ${still.status}, model calls still ${calls}`,
      );
      // A failed write releases its slot: free one by deleting a set's claim
      // and rows (as a release would for a pending claim), and the next
      // student gets it.
      await sql`delete from questions where reading_id = ${readingId} and student_id = ${served}`;
      await sql`delete from question_generations where reading_id = ${readingId} and student_id = ${served}`;
      const failed = await getOrCreateStudentQuestions(readingId, refused, {
        write: async () => {
          calls++;
          throw new Error("mock model failure");
        },
      });
      const { n: afterFail } = await one<{ n: number }>(sql`
        select count(*)::int as n from question_generations where reading_id = ${readingId}`);
      const retry = await getOrCreateStudentQuestions(readingId, refused, { write });
      check(
        failed.status === "error" && afterFail === limit - 1 && retry.status === "ready",
        `freed slot: failed write ${failed.status}, claims after release ${afterFail} (want ${limit - 1}), retry ${retry.status}`,
      );
    }
  }
}

async function checkClassGrade() {
  console.log("\n== CLASS GRADE CHANGE ==");
  const { id: gradeClass } = await one<{ id: string }>(sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${teacherId}, 'Grade check', '4', ${`QG${RUN_ID}`.toUpperCase().slice(0, 8)})
    returning id`);
  const add = async (title: string, grade: string | null, status: string) => {
    const { id } = await one<{ id: string }>(sql`
      insert into readings (class_id, title, body_text, grade_level, question_count, question_mode, status)
      values (${gradeClass}, ${title}, ${BODY}, ${grade}::grade_level, 3, 'shared', ${status}::reading_status)
      returning id`);
    await sql`
      insert into questions (reading_id, student_id, position, prompt)
      select ${id}::uuid, null, p, 'Q' || p from generate_series(1, 3) as p`;
    return id;
  };
  const follows = await add("Follows class", null, "draft");
  const override = await add("Override", "7", "draft");
  const published = await add("Published", null, "published");
  const n = async (id: string) =>
    (await one<{ n: number }>(sql`select count(*)::int as n from questions where reading_id = ${id}`)).n;

  const setGrade = async (owner: string, gradeLevel: "6") =>
    (await updateClassSettings(gradeClass, owner, { name: "Grade check", gradeLevel })).status === "saved";
  check(!(await setGrade("00000000-0000-4000-8000-0000000000ff", "6")), "another teacher can't change the grade");
  check((await n(follows)) === 3, "nothing cleared for another teacher");
  check(await setGrade(teacherId, "6"), "grade changed 4 -> 6");
  const { g } = await one<{ g: string }>(sql`select grade_level as g from classes where id = ${gradeClass}`);
  const after = [await n(follows), await n(override), await n(published)];
  check(
    g === "6" && after.join(",") === "0,3,3",
    `class grade ${g}; questions left: follows-class draft ${after[0]}, override draft ${after[1]}, published ${after[2]} (want 0,3,3)`,
  );
  await sql`
    insert into questions (reading_id, student_id, position, prompt)
    select ${follows}::uuid, null, p, 'Q' || p from generate_series(1, 3) as p`;
  check(
    (await setGrade(teacherId, "6")) && (await n(follows)) === 3,
    "same grade again clears nothing",
  );
}

async function checkRateLimit() {
  console.log(`\n== GENERATION RATE LIMIT: 40 parallel ==`);
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, () => recordQuestionGeneration(teacherId)),
  );
  const allowed = results.filter((r) => r.status === "fulfilled" && r.value).length;
  const blocked = results.filter((r) => r.status === "fulfilled" && !r.value).length;
  const errors = results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error)?.message)] : []));
  const thrown = errors.length;
  const { n } = await one<{ n: number }>(sql`
    select count(*)::int as n from question_generation_attempts where teacher_id = ${teacherId}`);
  check(
    allowed === QUESTION_GENERATION_LIMIT && blocked === 10 && thrown === 0 && n === 30,
    `allowed ${allowed}, blocked ${blocked}, threw ${thrown}, rows ${n} (want 30/10/0/30)` +
      (thrown ? `: ${[...new Set(errors)].join("; ").slice(0, 300)}` : ""),
  );
}

async function checkShared() {
  console.log("\n== SHARED QUESTIONS: lock and count rules ==");
  const { id: readingId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Shared check', ${BODY}, ${COUNT}, 'shared', 'draft')
    returning id`);
  const ref: ReadingRef = { classId, readingId, teacherId };
  const fp = { bodyMd5: bodyMd5(BODY), gradeLevel: "4" as const, questionCount: COUNT };
  const count = async () =>
    (await one<{ c: number }>(sql`select question_count as c from readings where id = ${readingId}`)).c;
  const list = async () => (await listSharedQuestions(readingId)).map((q) => `${q.position}:${q.prompt}`);

  check(!(await publishReading(ref)), "publish refused with no questions");
  check(await saveQuestionSet(ref, fp, TRICKY, "generate"), "generate saved 3");
  check((await list()).join("|") === TRICKY.map((p, i) => `${i + 1}:${p}`).join("|"), "prompts and positions round-trip exactly");
  check(!(await saveQuestionSet(ref, fp, TRICKY, "generate")), "second generate refused (no double insert)");
  check(
    !(await saveQuestionSet(ref, { ...fp, bodyMd5: "stale" }, TRICKY, "replace")) && (await list()).length === 3,
    "regenerate for old text refused, set kept",
  );

  // 10 parallel regenerate-all: positions never collide, set stays 3.
  const replaces = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      saveQuestionSet(ref, fp, [`R${i} a?`, `R${i} b?`, `R${i} c?`], "replace"),
    ),
  );
  const replaceErrors = replaces.filter((r) => r.status === "rejected").length;
  const after = await listSharedQuestions(readingId);
  check(
    replaceErrors === 0 && after.map((q) => q.position).join(",") === "1,2,3" &&
      new Set(after.map((q) => q.prompt.split(" ")[0])).size === 1,
    `10 parallel regenerate-all: errors ${replaceErrors}, positions [${after.map((q) => q.position)}], one set`,
  );

  const [first, second] = after;
  check(await deleteSharedQuestion(ref, second.id), "delete the middle question");
  check(
    (await count()) === 2 && (await list()).map((s) => s.split(":")[0]).join(",") === "1,2",
    `count ${await count()}, positions [${(await list()).map((s) => s.split(":")[0])}] after delete`,
  );
  check(await deleteSharedQuestion(ref, first.id), "delete the first question");
  const [last] = await listSharedQuestions(readingId);
  check(!(await deleteSharedQuestion(ref, last.id)) && (await count()) === 1, "last question can't be deleted");
  check(await updateSharedQuestion(ref, last.id, "Edited?"), "edit a question");

  const edit = { title: "Shared check", bodyText: BODY, gradeLevel: null, questionCount: 1, questionMode: "shared" as const };
  await saveReadingEdit(classId, readingId, teacherId, { ...edit, title: "Renamed" });
  check((await list()).length === 1, "title-only edit keeps the questions");
  await saveReadingEdit(classId, readingId, teacherId, { ...edit, questionCount: 2 });
  check((await list()).length === 0 && (await count()) === 2, "changing the count clears the questions");
  check(!(await publishReading(ref)), "publish refused after clearing");

  const fp2 = { ...fp, questionCount: 2 };
  check(await saveQuestionSet(ref, fp2, ["P1?", "P2?"], "generate"), "generate again");
  check(await publishReading(ref), "publish");
  const [q] = await listSharedQuestions(readingId);
  check(!(await updateSharedQuestion(ref, q.id, "Late?")), "edit refused after publish");
  check(!(await deleteSharedQuestion(ref, q.id)), "delete refused after publish");
  check(!(await saveQuestionSet(ref, fp2, ["X?", "Y?"], "replace")), "regenerate all refused after publish");
  const published = { ...edit, questionCount: 2 };
  const title = async () =>
    (await one<{ t: string }>(sql`select title as t from readings where id = ${readingId}`)).t;
  for (const [what, change] of [
    ["text", { bodyText: BODY + " More." }],
    ["grade", { gradeLevel: "5" as const }],
    ["count", { questionCount: 3 }],
    ["mode", { questionMode: "per_student" as const }],
  ] as const) {
    const applied = await saveReadingEdit(classId, readingId, teacherId, { ...published, title: "Nope", ...change });
    check(!applied && (await title()) === "Shared check", `published: ${what} change refused, title unchanged`);
  }
  check(
    await saveReadingEdit(classId, readingId, teacherId, { ...published, title: "Renamed after publish" }),
    "published: title-only edit saved",
  );
  check((await title()) === "Renamed after publish", `published: title is now "${await title()}"`);
  check(
    !(await saveReadingEdit(classId, readingId, "00000000-0000-4000-8000-0000000000ff", { ...published, title: "Hijack" })),
    "published: another teacher can't rename it",
  );
  check((await list()).join("|") === "1:P1?|2:P2?", "published questions unchanged");

  // Publish racing edits: whatever the order, never published with a
  // set that doesn't match question_count.
  const { id: raceId } = await one<{ id: string }>(sql`
    insert into readings (class_id, title, body_text, question_count, question_mode, status)
    values (${classId}, 'Race', ${BODY}, 3, 'shared', 'draft') returning id`);
  const raceRef = { ...ref, readingId: raceId };
  await saveQuestionSet(raceRef, fp, TRICKY, "generate");
  const qs = await listSharedQuestions(raceId);
  await Promise.allSettled([
    publishReading(raceRef),
    deleteSharedQuestion(raceRef, qs[0].id),
    updateSharedQuestion(raceRef, qs[1].id, "Racing edit?"),
    publishReading(raceRef),
  ]);
  const race = await one<{ status: string; question_count: number; n: number }>(sql`
    select r.status, r.question_count,
      (select count(*)::int from questions where reading_id = r.id and student_id is null) as n
    from readings r where r.id = ${raceId}`);
  check(
    race.status === "published" && race.question_count === race.n,
    `publish vs edits: ${race.status}, question_count ${race.question_count}, rows ${race.n}`,
  );
}

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id = ${`test_questions_${RUN_ID}`} returning id`;
  console.log(`\ncleanup: deleted ${rows.length} test teacher (and everything under it)`);
}

async function main(): Promise<void> {
  const [info] = await sql`select current_setting('server_version') as version`;
  console.log(`run ${RUN_ID}: postgres ${info.version}, endpoint=${fetchEndpoint ?? "default"}`);
  try {
    const { readingId, students, otherStudent, draftId } = await setup();
    const raceStudents = students.slice(0, STUDENTS);
    const [staleStudent, failStudent, spare] = students.slice(STUDENTS);
    await checkStudentRaces(readingId, raceStudents);
    await checkStaleTakeover(readingId, staleStudent);
    await checkFailureReleases(readingId, failStudent);
    await checkNotFound(readingId, draftId, otherStudent, spare);
    await checkCap();
    // The local neon-proxy needs time for the Postgres backends from the cap
    // race to exit; without this pause the burst below hit proxy connection
    // churn (the earlier 33 errors), not the limiter.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await checkRateLimit();
    await checkShared();
    await checkClassGrade();
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
  console.error("check-student-questions crashed:", error);
  process.exit(1);
});
