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

import type { GradeLevel } from "./grade-levels";
import type { Statement } from "./link-rate-limit";
import {
  QUESTION_ERROR_MESSAGES,
  questionErrorKind,
  questionErrorLogFields,
  type QuestionErrorKind,
} from "./ai/questions";
import { QUESTION_WRITE_MAX_MS } from "./ai/settings";

// Longer than the most a winner can take (every attempt and SDK retry
// timing out), plus margin, so a live winner is never taken over. Twice
// the SDK timeout alone would be too short: a winner can make up to 4
// timed requests (2 attempts x 2 tries).
export const CLAIM_STALE_SECONDS = Math.ceil(QUESTION_WRITE_MAX_MS / 1000) + 30;

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
  // No published per-student reading with that id in the student's class.
  | { status: "not_found" }
  // The model call failed; nothing was saved and the claim was released.
  | { status: "error"; kind: QuestionErrorKind; message: string };

export type StudentQuestionStore = {
  loadContext(readingId: string, studentId: string): Promise<StudentReadingContext | undefined>;
  readQuestions(readingId: string, studentId: string): Promise<StudentQuestion[]>;
  // True if this token now holds a new claim.
  claim(readingId: string, studentId: string, token: string): Promise<boolean>;
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
  const context = await store.loadContext(readingId, studentId);
  if (!context) return { status: "not_found" };

  const cached = await store.readQuestions(readingId, studentId);
  if (cached.length > 0) return { status: "ready", questions: cached };

  const token = deps.newToken();
  const won =
    (await store.claim(readingId, studentId, token)) ||
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

export function studentContextStatement(readingId: string, studentId: string): Statement {
  return {
    text: `select r.body_text, coalesce(r.grade_level, c.grade_level) as grade_level, r.question_count
from readings r
join classes c on c.id = r.class_id
join students s on s.class_id = r.class_id
where r.id = $1::uuid and s.id = $2::uuid
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

export function claimStatement(readingId: string, studentId: string, token: string): Statement {
  return {
    text: `insert into question_generations (reading_id, student_id, claim_token)
values ($1::uuid, $2::uuid, $3::uuid)
on conflict do nothing
returning claim_token`,
    params: [readingId, studentId, token],
  };
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
