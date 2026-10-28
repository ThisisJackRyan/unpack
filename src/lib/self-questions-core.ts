// A self-learner's question set for their own reading: written once by the
// model the first time the reading page opens, then cached. The same idea
// as a student's own set (student-questions-core.ts), sized for one owner:
// pure logic over an injected store and writer, so tests run it with
// fakes; the Postgres store is postgresSelfQuestionStore below.
//
// Race safety and cost: one person can still open the page in two tabs or
// reload while the model writes. So:
//
// 1. Load the reading, scoped to the account (another account's reading,
//    or a malformed id, is not_found). Cached set: done.
// 2. Claim, in ONE transaction: lock the account row (the lock the link
//    and question limiters take), then, in one statement, record a
//    question generation against the account's limit
//    (question_generation_attempts, QUESTION_GENERATION_LIMIT per
//    QUESTION_GENERATION_WINDOW_MINUTES, the teacher limit reused) and set
//    the reading's claim token, both only while the reading has no
//    questions and no live claim (unset, or older than
//    CLAIM_STALE_SECONDS) and the account is under the limit. Exactly one
//    request wins; the rest get pending (or rate_limited).
// 3. The winner calls the model with no transaction open.
// 4. Commit, in one statement: clear the claim and insert the set, only
//    while this token still holds it and the account is still a
//    self-learner (a role switch mid-write saves nothing). The unique (reading, position) is
//    the backstop.
// 5. On a model error, clear the claim (only if this token holds it), so
//    the next open (Try again) can claim again. Every claim counted toward
//    the account's limit, so retries are bounded.
//
// The weekly allowance slot (see self-allowance.ts): a reading whose
// question write was attempted and failed gives its slot back. Only the
// release in step 5 sets slot_released_at (while the reading has no
// questions), and only after a claimed write threw. An open that doesn't
// call the model keeps the slot: not set up, the account's question limit,
// another tab's live claim, not found. Such a reading still gets its
// questions on a later open, with the slot it holds. Releasing there would
// let an account at its question limit create, open (rate_limited, slot
// back) and repeat without end; a release after a write is bounded by the
// question limit, since every claim counts toward it. The claim in step 2
// takes a released slot back (clears slot_released_at) in the same
// statement, only while the account has a free slot (or the reading is
// already older than the window), under the account lock the create
// takes, so creates and Try agains together never hold more than the
// allowance. No free slot: "limit_reached", and the page shows when the
// next one frees up.

import type { QuestionErrorKind, QuestionModel } from "./ai/questions";
import { questionErrorKind, questionErrorLogFields, writeQuestionSet } from "./ai/questions";
import type { GradeLevel } from "./grade-levels";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import {
  allowanceFor,
  allowanceFromRow,
  allowanceStatement,
  heldSlotsSql,
  selfLearnerPlan,
  type AllowanceState,
  type ReadingAllowance,
} from "./self-allowance";
import { dateFromRow, withRetryAt, type RetryClock } from "./local-time";
import {
  QUESTION_GENERATION_LIMIT,
  QUESTION_GENERATION_PRUNE_HOURS,
  QUESTION_GENERATION_WINDOW_MINUTES,
  questionGenerationRetryAtStatement,
} from "./question-rate-limit";
import {
  CLAIM_STALE_SECONDS,
  PENDING_RETRY_AFTER_MS,
  type StudentQuestion,
} from "./student-questions-core";
import { questionErrorView, SELF_QUESTIONS_UNAVAILABLE_MESSAGE, type StudentReadingView } from "./student-reading-view";

// At the account's question writing limit (the teacher limit, reused):
// an amber note, then when the next one frees up.
export const SELF_QUESTIONS_LIMITED_MESSAGE = `You’ve asked for a lot of questions in the last ${QUESTION_GENERATION_WINDOW_MINUTES} minutes, so let’s take a short break.`;

export type SelfReadingContext = { bodyText: string; gradeLevel: GradeLevel; questionCount: number };

export type SelfClaimOutcome = "claimed" | "ready" | "pending" | "rate_limited" | "limit_reached" | "not_found";

export type SelfQuestionStore = {
  loadContext(accountId: string, readingId: string): Promise<SelfReadingContext | null>;
  readQuestions(accountId: string, readingId: string): Promise<StudentQuestion[]>;
  claim(accountId: string, readingId: string, token: string, allowance: ReadingAllowance): Promise<SelfClaimOutcome>;
  // After this token's write failed: clears its claim, and releases the
  // reading's slot if it has no questions.
  release(accountId: string, readingId: string, token: string): Promise<void>;
  // Where the allowance stands, for the limit_reached message.
  allowanceState(accountId: string, allowance: ReadingAllowance): Promise<AllowanceState>;
  // After "rate_limited": when the next question write frees up, if the
  // store can say.
  rateLimitedUntil?(accountId: string): Promise<Date | null>;
  // False when the claim was lost (taken over after going stale).
  commit(accountId: string, readingId: string, token: string, prompts: string[]): Promise<boolean>;
};

export type SelfQuestionWriter = (context: SelfReadingContext) => Promise<string[]>;

// The model writer: the reading's level and count, with the solo system
// prompt (the reader chose the reading; no teacher or students). getModel
// runs per write, so the app reads its config only when it writes.
export function selfQuestionWriter(getModel: () => QuestionModel): SelfQuestionWriter {
  return (context) =>
    writeQuestionSet(
      getModel(),
      { bodyText: context.bodyText, gradeLevel: context.gradeLevel, count: context.questionCount },
      { audience: "solo" },
    );
}

export type SelfQuestionDeps = {
  store: SelfQuestionStore;
  write: SelfQuestionWriter;
  newToken: () => string;
  // False without AI Gateway credentials: fail before claiming, so nothing
  // is counted. The reading keeps its slot (no model call was made) and
  // gets its questions once question writing is set up.
  configured?: boolean;
  // The account's plan allowance; the free plan by default.
  allowance?: ReadingAllowance;
  // Safe fields only (never the text or prompts).
  onError?: (fields: Record<string, unknown>) => void;
};

export type SelfQuestionsResult =
  | { status: "ready"; questions: StudentQuestion[] }
  | { status: "pending"; retryAfterMs: number }
  | { status: "rate_limited"; retryAt: Date | null }
  // A released reading's Try again with every slot in use.
  | { status: "limit_reached"; state: AllowanceState }
  | { status: "not_found" }
  | { status: "error"; kind: QuestionErrorKind };

async function readyOrPending(
  store: SelfQuestionStore,
  accountId: string,
  readingId: string,
): Promise<SelfQuestionsResult> {
  const questions = await store.readQuestions(accountId, readingId);
  return questions.length > 0
    ? { status: "ready", questions }
    : { status: "pending", retryAfterMs: PENDING_RETRY_AFTER_MS };
}

export async function getOrCreateSelfQuestionsWith(
  accountId: string,
  readingId: string,
  deps: SelfQuestionDeps,
): Promise<SelfQuestionsResult> {
  const { store } = deps;
  const context = await store.loadContext(accountId, readingId);
  if (!context) return { status: "not_found" };

  const cached = await store.readQuestions(accountId, readingId);
  if (cached.length > 0) return { status: "ready", questions: cached };

  if (deps.configured === false) return { status: "error", kind: "not_configured" };

  const allowance = deps.allowance ?? allowanceFor(selfLearnerPlan());
  const token = deps.newToken();
  const claim = await store.claim(accountId, readingId, token, allowance);
  if (claim === "not_found") return { status: claim };
  // The reading keeps its slot: no model call, and it gets its questions
  // after the wait.
  if (claim === "rate_limited") {
    // Only for the message: if it can't be read, a relative time.
    return { status: claim, retryAt: (await store.rateLimitedUntil?.(accountId).catch(() => null)) ?? null };
  }
  if (claim === "limit_reached") return { status: claim, state: await store.allowanceState(accountId, allowance) };
  if (claim === "ready" || claim === "pending") return readyOrPending(store, accountId, readingId);

  let prompts: string[];
  try {
    prompts = await deps.write(context);
  } catch (error) {
    deps.onError?.(questionErrorLogFields(error));
    // The only place a slot is released: a write was attempted and failed.
    await store.release(accountId, readingId, token);
    return { status: "error", kind: questionErrorKind(error) };
  }

  try {
    await store.commit(accountId, readingId, token, prompts);
  } catch (error) {
    // Only a second writer caught by the unique index: read what it saved.
    if ((error as { code?: unknown } | null)?.code !== "23505") throw error;
  }
  return readyOrPending(store, accountId, readingId);
}

// What the reading page shows (the student view kinds, so the page reuses
// the student read view's pieces). No teacher to ask: an error or the
// limit is a break and Try again.
// `clock` (now and the reader's zone) turns the question limit's retry
// time into "You can try again at 2:40 PM."; without it, a relative time.
export function selfQuestionsView(result: SelfQuestionsResult, clock: RetryClock | null = null): StudentReadingView {
  switch (result.status) {
    case "ready":
      return { kind: "questions", questions: result.questions };
    case "pending":
      return { kind: "pending", retryAfterMs: result.retryAfterMs };
    case "rate_limited":
      return { kind: "throttled", message: withRetryAt(SELF_QUESTIONS_LIMITED_MESSAGE, result.retryAt, clock) };
    case "limit_reached":
      // The page shows the allowance note (with the time) instead.
      return { kind: "limit_reached", message: SELF_QUESTIONS_LIMITED_MESSAGE };
    case "error":
      return questionErrorView(result.kind, SELF_QUESTIONS_UNAVAILABLE_MESSAGE);
    case "not_found":
      return { kind: "not_found" };
  }
}

// Statements for the Postgres store, kept here so tests can check them.
// $1 account, $2 reading throughout.

export function selfContextStatement(accountId: string, readingId: string): Statement {
  return {
    text: `select body_text, grade_level, question_count from self_readings
where id = $2::uuid and account_id = $1::uuid`,
    params: [accountId, readingId],
  };
}

export function selfQuestionsStatement(accountId: string, readingId: string): Statement {
  return {
    text: `select q.id, q.position, q.prompt
from self_questions q
join self_readings r on r.id = q.reading_id
where q.reading_id = $2::uuid and r.account_id = $1::uuid
order by q.position`,
    params: [accountId, readingId],
  };
}

// The reading is the account's, the account is a self-learner now, and
// the reading has no questions and no live claim. $n: CLAIM_STALE_SECONDS.
function claimable(n: number): string {
  return `exists (
  select 1 from self_readings r join teachers t on t.id = r.account_id
  where r.id = $2::uuid and r.account_id = $1::uuid and t.role = 'self_learner'
    and not exists (select 1 from self_questions q where q.reading_id = r.id)
    and (r.questions_claim_token is null or r.questions_claimed_at < now() - make_interval(secs => $${n}::int))
)`;
}

// The account's question generations in the limit's window. $n: minutes.
function recentGenerations(n: number): string {
  return `(select count(*) from question_generation_attempts
  where teacher_id = $1::uuid and created_at > now() - make_interval(mins => $${n}::int))`;
}

// The reading holds its slot, or can take one back: not released, already
// older than the window ($w: window days), or fewer than the allowance
// ($a) hold a slot. $1 account, $2 reading.
function slotFree(w: number, a: number): string {
  return `(
  coalesce((select r.slot_released_at is null or r.created_at <= now() - make_interval(days => $${w}::int)
    from self_readings r where r.id = $2::uuid and r.account_id = $1::uuid), false)
  or ${heldSlotsSql(w)} < $${a}::int
)`;
}

// The claim, as ONE READ COMMITTED transaction (see the top of this file):
// 1. Lock the account row, so this account's claims, creates, and limiter
//    counts queue up here (a few milliseconds).
// 2. Count the generation, take the claim, and take the slot back (if it
//    was released) together, only when all of it holds (a fresh snapshot
//    after the lock wait, so exact).
// 3. Prune the account's generation rows older than the prune window, as
//    the limiter does.
// 4. Say why when nothing was claimed.
export function selfClaimStatements(
  accountId: string,
  readingId: string,
  token: string,
  allowance: ReadingAllowance = allowanceFor(selfLearnerPlan()),
): Statement[] {
  return [
    { text: "select id from teachers where id = $1::uuid for update", params: [accountId] },
    {
      // $3 token, $4 stale seconds, $5 window minutes, $6 limit, $7
      // allowance readings, $8 allowance days.
      text: `with counted as (
  insert into question_generation_attempts (teacher_id)
  select $1::uuid
  where ${claimable(4)}
    and ${recentGenerations(5)} < $6::int
    and ${slotFree(8, 7)}
  returning id
)
update self_readings set questions_claim_token = $3::uuid, questions_claimed_at = now(), slot_released_at = null
where id = $2::uuid and account_id = $1::uuid and exists (select 1 from counted)
returning id`,
      params: [
        accountId,
        readingId,
        token,
        CLAIM_STALE_SECONDS,
        QUESTION_GENERATION_WINDOW_MINUTES,
        QUESTION_GENERATION_LIMIT,
        allowance.readings,
        allowance.windowDays,
      ],
    },
    {
      text: `delete from question_generation_attempts
where teacher_id = $1::uuid
  and created_at < now() - make_interval(hours => $2::int)`,
      params: [accountId, QUESTION_GENERATION_PRUNE_HOURS],
    },
    {
      // $3 stale seconds, $4 window minutes, $5 allowance readings, $6
      // allowance days.
      text: `select
  exists (
    select 1 from self_readings r join teachers t on t.id = r.account_id
    where r.id = $2::uuid and r.account_id = $1::uuid and t.role = 'self_learner'
  ) as owned,
  exists (
    select 1 from self_questions q join self_readings r on r.id = q.reading_id
    where q.reading_id = $2::uuid and r.account_id = $1::uuid
  ) as has_questions,
  ${claimable(3)} as claimable,
  ${recentGenerations(4)}::int as recent,
  ${slotFree(6, 5)} as slot_free`,
      params: [accountId, readingId, CLAIM_STALE_SECONDS, QUESTION_GENERATION_WINDOW_MINUTES, allowance.readings, allowance.windowDays],
    },
  ];
}

export function selfClaimOutcome(results: Record<string, unknown>[][]): SelfClaimOutcome {
  if ((results[1]?.length ?? 0) > 0) return "claimed";
  const row = results[3]?.[0];
  if (row?.owned !== true) return "not_found";
  if (row.has_questions === true) return "ready";
  // Someone else holds a live claim: wait for it.
  if (row.claimable !== true) return "pending";
  // Before the question limit: after a break there would still be no slot.
  if (row.slot_free === false) return "limit_reached";
  if (Number(row.recent ?? 0) >= QUESTION_GENERATION_LIMIT) return "rate_limited";
  return "pending";
}

// After this token's write failed: clears its claim and, while the
// reading has no questions, releases its slot.
export function selfReleaseStatement(accountId: string, readingId: string, token: string): Statement {
  return {
    text: `update self_readings set questions_claim_token = null, questions_claimed_at = null,
  slot_released_at = case
    when exists (select 1 from self_questions q where q.reading_id = self_readings.id) then slot_released_at
    else coalesce(slot_released_at, now())
  end
where id = $2::uuid and account_id = $1::uuid and questions_claim_token = $3::uuid`,
    params: [accountId, readingId, token],
  };
}

// One statement: clear this token's claim and, only if it did, insert the
// set. $3 token, $4 positions, $5 prompts.
export function selfCommitStatement(accountId: string, readingId: string, token: string, prompts: string[]): Statement {
  return {
    text: `with held as (
  update self_readings set questions_claim_token = null, questions_claimed_at = null
  where id = $2::uuid and account_id = $1::uuid and questions_claim_token = $3::uuid
    and exists (select 1 from teachers t where t.id = $1::uuid and t.role = 'self_learner')
  returning id
)
insert into self_questions (reading_id, position, prompt)
select held.id, p.position, p.prompt
from held cross join unnest($4::int[], $5::text[]) as p(position, prompt)
returning id`,
    params: [accountId, readingId, token, prompts.map((_, i) => i + 1), prompts],
  };
}

export function postgresSelfQuestionStore(execute: StatementExecutor): SelfQuestionStore {
  const one = async (statement: Statement) => (await execute([statement]))[0] ?? [];
  return {
    async loadContext(accountId, readingId) {
      const [row] = await one(selfContextStatement(accountId, readingId));
      if (!row) return null;
      return {
        bodyText: String(row.body_text),
        gradeLevel: row.grade_level as GradeLevel,
        questionCount: Number(row.question_count),
      };
    },
    async readQuestions(accountId, readingId) {
      const rows = await one(selfQuestionsStatement(accountId, readingId));
      return rows.map((r) => ({ id: String(r.id), position: Number(r.position), prompt: String(r.prompt) }));
    },
    async claim(accountId, readingId, token, allowance) {
      return selfClaimOutcome(await execute(selfClaimStatements(accountId, readingId, token, allowance)));
    },
    async release(accountId, readingId, token) {
      await one(selfReleaseStatement(accountId, readingId, token));
    },
    async allowanceState(accountId, allowance) {
      const [row] = await one(allowanceStatement(accountId, allowance));
      return allowanceFromRow(row, allowance);
    },
    async rateLimitedUntil(accountId) {
      const [row] = await one(questionGenerationRetryAtStatement(accountId));
      return dateFromRow(row?.retry_at);
    },
    async commit(accountId, readingId, token, prompts) {
      const rows = await one(selfCommitStatement(accountId, readingId, token, prompts));
      return rows.length === prompts.length;
    },
  };
}
