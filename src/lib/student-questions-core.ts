// A student's own question set in per-student mode: generated once, the
// first time they open the reading, then cached and never regenerated
// (retries reuse it). Pure logic over an injected store and model, so
// tests can run it with fakes. The Postgres store is student-questions.ts.
//
// Race safety: a class can open a reading at the same moment, and one
// student can open it in two tabs. The model must be called at most once
// per student per reading, and the set must never be saved twice. So:
//
// 1. Read the cached set. If present, done.
// 2. Claim: insert a question_generations row (reading, student) with a
//    fresh token, ON CONFLICT DO NOTHING. Exactly one request gets the row.
//    The insert is also where the per-reading cap and the class check are
//    enforced (see claimStatements).
// 3. Losers don't call the model: they re-read and return the set if it
//    has landed, or "pending" (the caller shows a short wait and retries).
// 4. The winner calls the model. On success it marks the claim "done" and
//    inserts the set in ONE transaction, only while its token still holds
//    the claim. On failure it deletes its claim, so the next open tries
//    again (a failed call saved nothing, so this isn't a regeneration).
// 5. A "pending" claim older than CLAIM_STALE_SECONDS belongs to a request
//    that died (a killed function, say). One later request may take it
//    over with a conditional update that swaps in its own token; the old
//    holder, if it ever wakes up, then fails its token check and saves
//    nothing.
//
// A "done" claim is kept forever, so no later request can start a second
// generation, even if it read the cache just before the set landed. The
// unique (reading, student, position) index is the final backstop.
//
// Backstops, since students trigger these calls and not the teacher:
// - Only a student whose class is the reading's class gets a set
//   ("not_allowed" otherwise), checked on load and again in the claim.
// - At most STUDENT_SETS_PER_READING_LIMIT sets per reading. Every claim
//   row, pending or done, holds a slot, so the cap counts claims, not
//   saved sets. A released claim frees its slot; a stale takeover reuses
//   one and is never blocked.
// - Student sets don't count toward the teacher's 30 per 10 minutes (see
//   question-rate-limit.ts); the cap above bounds them instead.
// - The "Try again" throttle: a failed call releases its claim, so every
//   Try again (or reload) would otherwise call the model again. Every
//   model call writes a student_question_calls row in the same transaction
//   as the claim or takeover that wins the right to call, and the claim is
//   refused once the student has made STUDENT_GENERATION_WINDOW_LIMIT calls
//   for this reading in the last STUDENT_GENERATION_WINDOW_MINUTES
//   ("throttled": take a break) or STUDENT_GENERATION_CALL_LIMIT in all
//   ("calls_used_up": ask the teacher). Only real model calls count: a
//   cached open, a loser that waits, and a refused claim write nothing.
//   The count runs under the same reading lock as the claim, so a burst
//   of Try agains makes exactly the limit of calls.

import type { GradeLevel } from "./grade-levels";
import type { Statement } from "./link-rate-limit";
import {
  QUESTION_ERROR_MESSAGES,
  questionErrorKind,
  questionErrorLogFields,
  type QuestionErrorKind,
} from "./ai/questions";
import { QUESTION_WRITE_DEADLINE_MS } from "./ai/settings";

// Longer than the most a winner's model call can take (the write deadline
// ends it, attempts, retries, and backoff included), plus 30s for the
// commit and slow starts, so a live winner is never taken over: 140s.
export const CLAIM_STALE_SECONDS = Math.ceil(QUESTION_WRITE_DEADLINE_MS / 1000) + 30;

// The most per-student sets one reading can have: a big class with room
// to spare. Past it, a new student's open is refused, so a leaked join
// code can't run up model calls without limit.
export const STUDENT_SETS_PER_READING_LIMIT = 150;

// What the student reading page shows on "limit_reached".
export const STUDENT_SETS_LIMITED_MESSAGE = "Ask your teacher for help with this one.";

// The "Try again" throttle (see the top of this file). A set normally
// takes 1 call (the SDK's own retries happen inside it), so 3 calls in 10
// minutes is room for two failures in a row, and 6 in all bounds what one
// student can cost on one reading however long the model keeps failing.
export const STUDENT_GENERATION_WINDOW_LIMIT = 3;
export const STUDENT_GENERATION_WINDOW_MINUTES = 10;
export const STUDENT_GENERATION_CALL_LIMIT = 6;

// What the student reading page shows on "throttled". On "calls_used_up"
// it shows STUDENT_SETS_LIMITED_MESSAGE.
export const STUDENT_GENERATION_THROTTLED_MESSAGE = "Let’s take a little break. Try again in a few minutes.";

// How long a "pending" caller should wait before asking again.
export const PENDING_RETRY_AFTER_MS = 2_000;

export type StudentQuestion = { id: string; position: number; prompt: string };

export type StudentReadingContext = {
  bodyText: string;
  gradeLevel: GradeLevel;
  questionCount: number;
};

export type StudentQuestionsResult =
  // The student's set, in order.
  | { status: "ready"; questions: StudentQuestion[] }
  // Another request is writing this student's set right now.
  | { status: "pending"; retryAfterMs: number }
  // No published per-student reading with that id.
  | { status: "not_found" }
  // The reading exists, but the student isn't in its class (or doesn't
  // exist). Never send this to a student as is: pass every result through
  // studentFacingResult, which turns it into not_found.
  | { status: "not_allowed" }
  // The reading already has STUDENT_SETS_PER_READING_LIMIT sets and this
  // student has none. Show STUDENT_SETS_LIMITED_MESSAGE.
  | { status: "limit_reached" }
  // STUDENT_GENERATION_WINDOW_LIMIT calls in the window: try again later.
  | { status: "throttled" }
  // STUDENT_GENERATION_CALL_LIMIT calls for all time: ask the teacher.
  | { status: "calls_used_up" }
  // The model call failed; nothing was saved and the claim was released.
  | { status: "error"; kind: QuestionErrorKind; message: string };

// What a student may be told: not_allowed becomes not_found, so a
// response can't reveal whether a student id exists or is in another
// class. Every student-facing caller should use this.
export type StudentFacingResult = Exclude<StudentQuestionsResult, { status: "not_allowed" }>;

export function studentFacingResult(result: StudentQuestionsResult): StudentFacingResult {
  return result.status === "not_allowed" ? { status: "not_found" } : result;
}

export type ContextLookup =
  | { status: "ok"; context: StudentReadingContext }
  | { status: "not_found" }
  | { status: "not_allowed" };

// What a claim attempt found:
// - "claimed": this token holds a new claim.
// - "exists": the student already has a claim (pending or done).
// - "limit_reached": no claim for this student, and the reading is at
//   STUDENT_SETS_PER_READING_LIMIT.
// - "refused": the reading or student no longer qualifies (deleted, say).
// - "throttled" / "calls_used_up": no claim for this student, and the
//   "Try again" throttle refuses another model call.
export type ClaimOutcome = "claimed" | "exists" | "limit_reached" | "refused" | "throttled" | "calls_used_up";

// What a stale takeover attempt found: "taken" (this token now holds it
// and may call the model), "not_stale" (someone is still writing, or it's
// done or gone), or the throttle refused it.
export type TakeOverOutcome = "taken" | "not_stale" | "throttled" | "calls_used_up";

export type StudentQuestionStore = {
  loadContext(readingId: string, studentId: string): Promise<ContextLookup>;
  readQuestions(readingId: string, studentId: string): Promise<StudentQuestion[]>;
  claim(readingId: string, studentId: string, token: string, limit: number): Promise<ClaimOutcome>;
  // Takes over a stale pending claim, under the throttle.
  takeOverStale(readingId: string, studentId: string, token: string, staleSeconds: number): Promise<TakeOverOutcome>;
  // Deletes the claim if this token still holds it and it is pending.
  release(readingId: string, studentId: string, token: string): Promise<void>;
  // Marks the claim done and saves the set, in one transaction, only if
  // this token still holds it. False when the claim was lost.
  commit(readingId: string, studentId: string, token: string, prompts: string[]): Promise<boolean>;
};

export type StudentQuestionWriter = (context: StudentReadingContext) => Promise<string[]>;

export type StudentQuestionDeps = {
  store: StudentQuestionStore;
  write: StudentQuestionWriter;
  newToken: () => string;
  // False when the model isn't set up (no API key): an open then fails
  // before claiming, so no call is counted that never reached the model.
  configured?: boolean;
  // Logs safe fields only (never the text, prompts, or names).
  onError?: (fields: Record<string, unknown>) => void;
};

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

async function readyOrPending(
  store: StudentQuestionStore,
  readingId: string,
  studentId: string,
): Promise<StudentQuestionsResult> {
  const questions = await store.readQuestions(readingId, studentId);
  return questions.length > 0
    ? { status: "ready", questions }
    : { status: "pending", retryAfterMs: PENDING_RETRY_AFTER_MS };
}

export async function getOrCreateStudentQuestionsWith(
  readingId: string,
  studentId: string,
  deps: StudentQuestionDeps,
): Promise<StudentQuestionsResult> {
  const { store } = deps;
  const lookup = await store.loadContext(readingId, studentId);
  if (lookup.status !== "ok") return { status: lookup.status };
  const { context } = lookup;

  const cached = await store.readQuestions(readingId, studentId);
  if (cached.length > 0) return { status: "ready", questions: cached };

  if (deps.configured === false) {
    return { status: "error", kind: "not_configured", message: QUESTION_ERROR_MESSAGES.not_configured };
  }

  const token = deps.newToken();
  const claim = await store.claim(readingId, studentId, token, STUDENT_SETS_PER_READING_LIMIT);
  if (claim === "limit_reached" || claim === "throttled" || claim === "calls_used_up") return { status: claim };
  if (claim === "refused") return { status: "not_found" };
  if (claim === "exists") {
    // An existing claim already holds a slot, so taking it over is never
    // blocked by the cap; it is by the throttle, since it calls the model.
    const takeOver = await store.takeOverStale(readingId, studentId, token, CLAIM_STALE_SECONDS);
    if (takeOver === "throttled" || takeOver === "calls_used_up") return { status: takeOver };
    if (takeOver === "not_stale") return readyOrPending(store, readingId, studentId);
  }

  let prompts: string[];
  try {
    prompts = await deps.write(context);
  } catch (error) {
    const kind = questionErrorKind(error);
    deps.onError?.(questionErrorLogFields(error));
    await store.release(readingId, studentId, token);
    return { status: "error", kind, message: QUESTION_ERROR_MESSAGES[kind] };
  }

  try {
    await store.commit(readingId, studentId, token, prompts);
  } catch (error) {
    // Only reachable if the unique index caught a second writer; whoever
    // won has saved a set, so read it.
    if (!isUniqueViolation(error)) throw error;
  }
  // Committed or lost the claim to a takeover: either way, read what's saved.
  return readyOrPending(store, readingId, studentId);
}

// Statements for the Postgres store, kept here so tests can check them.
// $1 reading, $2 student throughout.

// One row when the reading is a published per-student one; in_class says
// whether the student is in its class (false for an unknown student).
export function studentContextStatement(readingId: string, studentId: string): Statement {
  return {
    text: `select r.body_text, coalesce(r.grade_level, c.grade_level) as grade_level, r.question_count,
  exists (
    select 1 from students s where s.id = $2::uuid and s.class_id = r.class_id
  ) as in_class
from readings r
join classes c on c.id = r.class_id
where r.id = $1::uuid
  and r.status = 'published' and r.question_mode = 'per_student'`,
    params: [readingId, studentId],
  };
}

export function studentQuestionsStatement(readingId: string, studentId: string): Statement {
  return {
    text: `select id, position, prompt from questions
where reading_id = $1::uuid and student_id = $2::uuid
order by position`,
    params: [readingId, studentId],
  };
}

// The claim, as ONE READ COMMITTED transaction (same pattern as
// linkFetchStatements, with the reading row as the lock):
//
// 1. Lock the reading row, so concurrent claims on one reading queue up
//    here for a few milliseconds. FOR NO KEY UPDATE, not FOR UPDATE: it
//    still conflicts with itself, but not with the FOR KEY SHARE lock that
//    inserts referencing the reading take (a winner's commit, later a
//    student's answers), so those never wait on a claim.
// 2. Insert the claim only if the student is in the reading's class, the
//    reading is still published per-student, and the reading has fewer
//    than $4 claims (pending or done). This statement's fresh snapshot,
//    taken after the lock wait, sees every claim a previous holder
//    committed, so the cap is exact: 200 concurrent first opens get
//    exactly 150. ON CONFLICT DO NOTHING keeps one claim per student.
//    It is also refused when the student is at the "Try again" throttle
//    (their student_question_calls rows for this reading, in the window
//    and in all), counted in the same fresh snapshot, so exact too.
// 3. Record the model call this claim is about to make, only if step 2
//    inserted this token's claim.
// 4. Say why when nothing was inserted: whether this student already has
//    a claim, whether the student and reading still qualify, how many
//    claims the reading has, and the student's calls.
//
// The model call happens after this commits, never under the lock.
// The student's calls for this reading in the window ($n: the window's
// minutes), and for all time.
function recentCalls(n: number): string {
  return `(select count(*) from student_question_calls
  where reading_id = $1::uuid and student_id = $2::uuid
    and created_at > now() - make_interval(mins => $${n}::int))`;
}
const ALL_CALLS = `(select count(*) from student_question_calls
  where reading_id = $1::uuid and student_id = $2::uuid)`;
const THROTTLE_PARAMS = [
  STUDENT_GENERATION_WINDOW_MINUTES,
  STUDENT_GENERATION_WINDOW_LIMIT,
  STUDENT_GENERATION_CALL_LIMIT,
];

export function claimStatements(
  readingId: string,
  studentId: string,
  token: string,
  limit: number,
): Statement[] {
  return [
    {
      text: `select id from readings where id = $1::uuid for no key update`,
      params: [readingId],
    },
    {
      text: `insert into question_generations (reading_id, student_id, claim_token)
select $1::uuid, $2::uuid, $3::uuid
where exists (
  select 1 from readings r join students s on s.class_id = r.class_id
  where r.id = $1::uuid and s.id = $2::uuid
    and r.status = 'published' and r.question_mode = 'per_student'
)
and (select count(*) from question_generations where reading_id = $1::uuid) < $4::int
and ${recentCalls(5)} < $6::int
and ${ALL_CALLS} < $7::int
on conflict do nothing
returning claim_token`,
      params: [readingId, studentId, token, limit, ...THROTTLE_PARAMS],
    },
    {
      text: `insert into student_question_calls (reading_id, student_id)
select $1::uuid, $2::uuid
where exists (
  select 1 from question_generations
  where reading_id = $1::uuid and student_id = $2::uuid
    and claim_token = $3::uuid and status = 'pending'
)
returning id`,
      params: [readingId, studentId, token],
    },
    {
      text: `select
  exists (
    select 1 from question_generations where reading_id = $1::uuid and student_id = $2::uuid
  ) as has_claim,
  exists (
    select 1 from readings r join students s on s.class_id = r.class_id
    where r.id = $1::uuid and s.id = $2::uuid
      and r.status = 'published' and r.question_mode = 'per_student'
  ) as eligible,
  (select count(*)::int from question_generations where reading_id = $1::uuid) as claims,
  ${recentCalls(3)}::int as recent_calls,
  ${ALL_CALLS}::int as all_calls`,
      params: [readingId, studentId, STUDENT_GENERATION_WINDOW_MINUTES],
    },
  ];
}

// Which throttle refuses another call, if any, from a row's recent_calls
// and all_calls.
function throttleFromRow(row: Record<string, unknown> | undefined): "throttled" | "calls_used_up" | null {
  if (Number(row?.all_calls ?? 0) >= STUDENT_GENERATION_CALL_LIMIT) return "calls_used_up";
  if (Number(row?.recent_calls ?? 0) >= STUDENT_GENERATION_WINDOW_LIMIT) return "throttled";
  return null;
}

// Reads the claim batch's results.
export function claimOutcome(results: Record<string, unknown>[][], limit: number): ClaimOutcome {
  if ((results[1]?.length ?? 0) > 0) return "claimed";
  const row = results[3]?.[0];
  if (row?.has_claim) return "exists";
  // Before the cap, so a student who doesn't qualify is refused, not told
  // the reading is full.
  if (row?.eligible !== true) return "refused";
  // The reading's cap first: after a break it would still be full.
  if (Number(row?.claims ?? 0) >= limit) return "limit_reached";
  return throttleFromRow(row) ?? "refused";
}

// The takeover, as ONE READ COMMITTED transaction:
// 1. The reading lock the claim takes, so the throttle count below is
//    exact against claims and other takeovers.
// 2. One statement: swap in this token only if the claim is still pending
//    and stale and the student is under the throttle, and record the call
//    it is about to make. Two requests that both see a stale claim can't
//    both take it: the second waits on the row lock, re-checks the WHERE
//    against the new claimed_at, and matches nothing. The final select
//    says why when nothing was taken (`stale` is read from the snapshot
//    before the update).
export function takeOverStatements(
  readingId: string,
  studentId: string,
  token: string,
  staleSeconds: number,
): Statement[] {
  return [
    {
      text: `select id from readings where id = $1::uuid for no key update`,
      params: [readingId],
    },
    {
      text: `with calls as (
  select ${recentCalls(5)}::int as recent_calls, ${ALL_CALLS}::int as all_calls
),
taken as (
  update question_generations
  set claim_token = $3::uuid, claimed_at = now()
  where reading_id = $1::uuid and student_id = $2::uuid
    and status = 'pending'
    and claimed_at < now() - make_interval(secs => $4::int)
    and (select recent_calls from calls) < $6::int
    and (select all_calls from calls) < $7::int
  returning claim_token
),
logged as (
  insert into student_question_calls (reading_id, student_id)
  select $1::uuid, $2::uuid from taken
  returning id
)
select
  (select count(*) from taken)::int as taken,
  (select count(*) from logged)::int as logged,
  calls.recent_calls,
  calls.all_calls,
  exists (
    select 1 from question_generations
    where reading_id = $1::uuid and student_id = $2::uuid
      and status = 'pending'
      and claimed_at < now() - make_interval(secs => $4::int)
  ) as stale
from calls`,
      params: [readingId, studentId, token, staleSeconds, ...THROTTLE_PARAMS],
    },
  ];
}

export function takeOverOutcome(results: Record<string, unknown>[][]): TakeOverOutcome {
  const row = results[1]?.[0];
  if (Number(row?.taken ?? 0) > 0) return "taken";
  if (row?.stale !== true) return "not_stale";
  return throttleFromRow(row) ?? "not_stale";
}

export function releaseStatement(readingId: string, studentId: string, token: string): Statement {
  return {
    text: `delete from question_generations
where reading_id = $1::uuid and student_id = $2::uuid
  and claim_token = $3::uuid and status = 'pending'`,
    params: [readingId, studentId, token],
  };
}

// Run as one transaction. Statement 1 flips this token's claim to done;
// statement 2 inserts only if that happened (a fresh snapshot sees it).
export function commitStatements(
  readingId: string,
  studentId: string,
  token: string,
  prompts: string[],
): Statement[] {
  return [
    {
      text: `update question_generations set status = 'done'
where reading_id = $1::uuid and student_id = $2::uuid
  and claim_token = $3::uuid and status = 'pending'
returning claim_token`,
      params: [readingId, studentId, token],
    },
    {
      text: `insert into questions (reading_id, student_id, position, prompt)
select $1::uuid, $2::uuid, p.position, p.prompt
from unnest($4::int[], $5::text[]) as p(position, prompt)
where exists (
  select 1 from question_generations
  where reading_id = $1::uuid and student_id = $2::uuid
    and claim_token = $3::uuid and status = 'done'
)
returning id`,
      params: [
        readingId,
        studentId,
        token,
        prompts.map((_, i) => i + 1),
        prompts,
      ],
    },
  ];
}
