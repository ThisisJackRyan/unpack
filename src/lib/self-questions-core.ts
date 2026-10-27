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
//    while this token still holds it. The unique (reading, position) is
//    the backstop.
// 5. On a model error, clear the claim (only if this token holds it), so
//    the next open (Try again) can claim again. Every claim counted toward
//    the account's limit, so retries are bounded.

import type { QuestionErrorKind, QuestionModel } from "./ai/questions";
import { questionErrorKind, questionErrorLogFields, writeQuestionSet } from "./ai/questions";
import type { GradeLevel } from "./grade-levels";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import {
  QUESTION_GENERATION_LIMIT,
  QUESTION_GENERATION_PRUNE_HOURS,
  QUESTION_GENERATION_WINDOW_MINUTES,
} from "./question-rate-limit";
import {
  CLAIM_STALE_SECONDS,
  PENDING_RETRY_AFTER_MS,
  STUDENT_GENERATION_THROTTLED_MESSAGE,
  type StudentQuestion,
} from "./student-questions-core";
import { QUESTIONS_ERROR_MESSAGE, type StudentReadingView } from "./student-reading-view";

export type SelfReadingContext = { bodyText: string; gradeLevel: GradeLevel; questionCount: number };

export type SelfClaimOutcome = "claimed" | "ready" | "pending" | "rate_limited" | "not_found";

export type SelfQuestionStore = {
  loadContext(accountId: string, readingId: string): Promise<SelfReadingContext | null>;
  readQuestions(accountId: string, readingId: string): Promise<StudentQuestion[]>;
  claim(accountId: string, readingId: string, token: string): Promise<SelfClaimOutcome>;
  release(accountId: string, readingId: string, token: string): Promise<void>;
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
  // False without an API key: fail before claiming, so nothing is counted.
  configured?: boolean;
  // Safe fields only (never the text or prompts).
  onError?: (fields: Record<string, unknown>) => void;
};

export type SelfQuestionsResult =
  | { status: "ready"; questions: StudentQuestion[] }
  | { status: "pending"; retryAfterMs: number }
  | { status: "rate_limited" }
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

  const token = deps.newToken();
  const claim = await store.claim(accountId, readingId, token);
  if (claim === "not_found" || claim === "rate_limited") return { status: claim };
  if (claim === "ready" || claim === "pending") return readyOrPending(store, accountId, readingId);

  let prompts: string[];
  try {
    prompts = await deps.write(context);
  } catch (error) {
    deps.onError?.(questionErrorLogFields(error));
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
export function selfQuestionsView(result: SelfQuestionsResult): StudentReadingView {
  switch (result.status) {
    case "ready":
      return { kind: "questions", questions: result.questions };
    case "pending":
      return { kind: "pending", retryAfterMs: result.retryAfterMs };
    case "rate_limited":
      return { kind: "throttled", message: STUDENT_GENERATION_THROTTLED_MESSAGE };
    case "error":
      return { kind: "error", message: QUESTIONS_ERROR_MESSAGE };
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

// The reading is the account's, has no questions, and no live claim.
// $n: CLAIM_STALE_SECONDS.
function claimable(n: number): string {
  return `exists (
  select 1 from self_readings r
  where r.id = $2::uuid and r.account_id = $1::uuid
    and not exists (select 1 from self_questions q where q.reading_id = r.id)
    and (r.questions_claim_token is null or r.questions_claimed_at < now() - make_interval(secs => $${n}::int))
)`;
}

// The account's question generations in the limit's window. $n: minutes.
function recentGenerations(n: number): string {
  return `(select count(*) from question_generation_attempts
  where teacher_id = $1::uuid and created_at > now() - make_interval(mins => $${n}::int))`;
}

// The claim, as ONE READ COMMITTED transaction (see the top of this file):
// 1. Lock the account row, so this account's claims and limiter counts
//    queue up here (a few milliseconds).
// 2. Count the generation and take the claim together, only when both
//    hold (a fresh snapshot after the lock wait, so exact).
// 3. Prune the account's generation rows older than the prune window, as
//    the limiter does.
// 4. Say why when nothing was claimed.
export function selfClaimStatements(accountId: string, readingId: string, token: string): Statement[] {
  return [
    { text: "select id from teachers where id = $1::uuid for update", params: [accountId] },
    {
      // $3 token, $4 stale seconds, $5 window minutes, $6 limit.
      text: `with counted as (
  insert into question_generation_attempts (teacher_id)
  select $1::uuid
  where ${claimable(4)}
    and ${recentGenerations(5)} < $6::int
  returning id
)
update self_readings set questions_claim_token = $3::uuid, questions_claimed_at = now()
where id = $2::uuid and account_id = $1::uuid and exists (select 1 from counted)
returning id`,
      params: [
        accountId,
        readingId,
        token,
        CLAIM_STALE_SECONDS,
        QUESTION_GENERATION_WINDOW_MINUTES,
        QUESTION_GENERATION_LIMIT,
      ],
    },
    {
      text: `delete from question_generation_attempts
where teacher_id = $1::uuid
  and created_at < now() - make_interval(hours => $2::int)`,
      params: [accountId, QUESTION_GENERATION_PRUNE_HOURS],
    },
    {
      // $3 stale seconds, $4 window minutes.
      text: `select
  exists (select 1 from self_readings where id = $2::uuid and account_id = $1::uuid) as owned,
  exists (
    select 1 from self_questions q join self_readings r on r.id = q.reading_id
    where q.reading_id = $2::uuid and r.account_id = $1::uuid
  ) as has_questions,
  ${claimable(3)} as claimable,
  ${recentGenerations(4)}::int as recent`,
      params: [accountId, readingId, CLAIM_STALE_SECONDS, QUESTION_GENERATION_WINDOW_MINUTES],
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
  if (Number(row.recent ?? 0) >= QUESTION_GENERATION_LIMIT) return "rate_limited";
  return "pending";
}

export function selfReleaseStatement(accountId: string, readingId: string, token: string): Statement {
  return {
    text: `update self_readings set questions_claim_token = null, questions_claimed_at = null
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
    async claim(accountId, readingId, token) {
      return selfClaimOutcome(await execute(selfClaimStatements(accountId, readingId, token)));
    },
    async release(accountId, readingId, token) {
      await one(selfReleaseStatement(accountId, readingId, token));
    },
    async commit(accountId, readingId, token, prompts) {
      const rows = await one(selfCommitStatement(accountId, readingId, token, prompts));
      return rows.length === prompts.length;
    },
  };
}
