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
export type ClaimOutcome = "claimed" | "exists" | "limit_reached" | "refused";

export type StudentQuestionStore = {
  loadContext(readingId: string, studentId: string): Promise<ContextLookup>;
  readQuestions(readingId: string, studentId: string): Promise<StudentQuestion[]>;
  claim(readingId: string, studentId: string, token: string, limit: number): Promise<ClaimOutcome>;
  // True if this token took over a stale pending claim.
  takeOverStale(readingId: string, studentId: string, token: string, staleSeconds: number): Promise<boolean>;
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

  const token = deps.newToken();
  const claim = await store.claim(readingId, studentId, token, STUDENT_SETS_PER_READING_LIMIT);
  if (claim === "limit_reached") return { status: "limit_reached" };
  if (claim === "refused") return { status: "not_found" };
  // An existing claim already holds a slot, so taking it over is never
  // blocked by the cap.
  const won =
    claim === "claimed" ||
    (await store.takeOverStale(readingId, studentId, token, CLAIM_STALE_SECONDS));
  if (!won) return readyOrPending(store, readingId, studentId);

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
// 3. Say why when nothing was inserted: whether this student already has
//    a claim, whether the student and reading still qualify, and how many
//    claims the reading has.
//
// The model call happens after this commits, never under the lock.
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
on conflict do nothing
returning claim_token`,
      params: [readingId, studentId, token, limit],
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
  (select count(*)::int from question_generations where reading_id = $1::uuid) as claims`,
      params: [readingId, studentId],
    },
  ];
}

// Reads the claim batch's results.
export function claimOutcome(results: Record<string, unknown>[][], limit: number): ClaimOutcome {
  if ((results[1]?.length ?? 0) > 0) return "claimed";
  const row = results[2]?.[0];
  if (row?.has_claim) return "exists";
  // Before the cap, so a student who doesn't qualify is refused, not told
  // the reading is full.
  if (row?.eligible !== true) return "refused";
  if (Number(row?.claims ?? 0) >= limit) return "limit_reached";
  return "refused";
}

// One statement, so two requests that both see a stale claim can't both
// take it: the second waits on the row lock, re-checks the WHERE against
// the new claimed_at, and matches nothing.
export function takeOverStatement(
  readingId: string,
  studentId: string,
  token: string,
  staleSeconds: number,
): Statement {
  return {
    text: `update question_generations
set claim_token = $3::uuid, claimed_at = now()
where reading_id = $1::uuid and student_id = $2::uuid
  and status = 'pending'
  and claimed_at < now() - make_interval(secs => $4::int)
returning claim_token`,
    params: [readingId, studentId, token, staleSeconds],
  };
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
