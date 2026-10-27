// A self-learner's answers: the student effort check flow
// (submitAnswersWith in submit-answers-core.ts, unchanged) over a store
// that reads and writes the self_* tables instead of the class ones. The
// same rules: validate against exactly these questions, one check running
// at a time, MAX_TRIES (3) tries and EFFORT_CHECK_LIMIT checks per reading,
// a claim and a commit under one advisory lock, nothing after a pass.
// Differences, all in the statements below:
// - Scoped to the owner: every statement checks self_readings.account_id,
//   so another account's reading is not_found.
// - No challenges, no one more try: the limits are always MAX_TRIES and
//   EFFORT_CHECK_LIMIT.
// - The reading's status is settled in the same transaction as the commit
//   (or the release of a failed check): passed on a passing try, moved_on
//   once every try (or every check) is used without a pass. The page then
//   shows the last try's nudges and a way to the next reading.
// Pure: SQL text and result mapping. The runner is self-readings.ts.

import { checkEffort } from "./ai/effort-check";
import type { QuestionModel } from "./ai/questions";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import type { AnswerStage, AttemptView, ReadingProgress } from "./reading-progress";
import { answerStage, readingProgress } from "./reading-progress";
import {
  ALREADY_PASSED_MESSAGE,
  CHECK_BUSY_MESSAGE,
  CHECK_FAILED_MESSAGE,
  claimOutcome,
  committedTry,
  EFFORT_CLAIM_STALE_SECONDS,
  OUT_OF_TRIES_MESSAGE,
  submitLookup,
  type AttemptStore,
  type EffortChecker,
  type SaveInput,
  type SubmitResult,
} from "./submit-answers-core";
import { selfQuestionsStatement } from "./self-questions-core";
import { ANSWERS_STALE_MESSAGE, EFFORT_CHECK_LIMIT, MAX_TRIES } from "./validate-answers";

// The model checker: the solo effort prompt (the reader chose the reading;
// no teacher or students). getModel runs per check.
export function selfEffortChecker(getModel: () => QuestionModel): EffortChecker {
  return (input) => checkEffort(getModel(), input, { audience: "solo" });
}

// Advisory lock namespace for a self-learner's reading (join-rate-limit.ts
// uses 1 and 2, reading-limits.ts 3). Keyed by the reading id alone: a
// reading has one owner.
export const SELF_EFFORT_LOCK_SPACE = 4;

export function selfEffortLockStatement(readingId: string): Statement {
  return {
    text: "select pg_advisory_xact_lock($1::int, hashtext($2::text))",
    params: [SELF_EFFORT_LOCK_SPACE, readingId.toLowerCase()],
  };
}

// $1 account, $2 reading throughout.
const OWNED = `exists (select 1 from self_readings where id = $2::uuid and account_id = $1::uuid)`;
const NOT_PASSED = `not exists (
  select 1 from self_attempts where reading_id = $2::uuid and account_id = $1::uuid and result = 'pass'
)`;
const TRIES = `(select count(*) from self_attempts where reading_id = $2::uuid and account_id = $1::uuid)`;
const CHECKS = `(select count(*) from self_effort_checks where reading_id = $2::uuid and account_id = $1::uuid)`;

// An unfinished check younger than the stale timeout, given as $n.
function liveCheck(n: number): string {
  return `exists (
  select 1 from self_effort_checks
  where reading_id = $2::uuid and account_id = $1::uuid
    and finished_at is null and created_at > now() - make_interval(secs => $${n}::int)
)`;
}

// The reading (owned), its questions, and the tries so far, in the shapes
// submitLookup reads.
export function selfSubmitContextStatements(accountId: string, readingId: string): Statement[] {
  return [
    {
      text: `select body_text, grade_level from self_readings where id = $2::uuid and account_id = $1::uuid`,
      params: [accountId, readingId],
    },
    selfQuestionsStatement(accountId, readingId),
    {
      text: `select count(*)::int as tries, coalesce(bool_or(result = 'pass'), false) as passed,
  $3::int as tries_allowed
from self_attempts where reading_id = $2::uuid and account_id = $1::uuid`,
      params: [accountId, readingId, MAX_TRIES],
    },
  ];
}

// The claim (same three steps and result shape as claimStatements in
// submit-answers-core.ts, so claimOutcome reads it).
export function selfClaimCheckStatements(accountId: string, readingId: string, claimId: string): Statement[] {
  return [
    selfEffortLockStatement(readingId),
    {
      // $3 claim id, $4 stale seconds, $5 tries, $6 checks.
      text: `insert into self_effort_checks (id, account_id, reading_id)
select $3::uuid, $1::uuid, $2::uuid
where ${OWNED}
and ${NOT_PASSED}
and ${TRIES} < $5::int
and not ${liveCheck(4)}
and ${CHECKS} < $6::int
returning id`,
      params: [accountId, readingId, claimId, EFFORT_CLAIM_STALE_SECONDS, MAX_TRIES, EFFORT_CHECK_LIMIT],
    },
    {
      // $3 stale seconds, $4 tries, $5 checks.
      text: `select ${OWNED} as eligible,
  not ${NOT_PASSED} as passed,
  ${TRIES}::int as tries,
  ${liveCheck(3)} as live,
  ${CHECKS}::int as checks,
  $4::int as tries_allowed,
  $5::int as checks_allowed`,
      params: [accountId, readingId, EFFORT_CLAIM_STALE_SECONDS, MAX_TRIES, EFFORT_CHECK_LIMIT],
    },
  ];
}

// Marks the reading passed or moved on once it is decided, and only once
// (status still in_progress): a pass, or every try or every check used
// with no check still running. Run after the commit or release in the
// same transaction (a fresh snapshot sees that write), and on each page
// load, so a check that died mid-way can't leave it in progress forever.
export function settleStatusStatement(accountId: string, readingId: string): Statement {
  return {
    // $3 tries, $4 checks, $5 stale seconds.
    text: `update self_readings set
  status = case when not ${NOT_PASSED} then 'passed'::self_reading_status else 'moved_on'::self_reading_status end,
  finished_at = now()
where id = $2::uuid and account_id = $1::uuid and status = 'in_progress'
  and (
    not ${NOT_PASSED}
    or ((${TRIES} >= $3::int or ${CHECKS} >= $4::int) and not ${liveCheck(5)})
  )
returning status`,
    params: [accountId, readingId, MAX_TRIES, EFFORT_CHECK_LIMIT, EFFORT_CLAIM_STALE_SECONDS],
  };
}

export function selfReleaseCheckStatements(accountId: string, readingId: string, claimId: string): Statement[] {
  return [
    selfEffortLockStatement(readingId),
    {
      text: `update self_effort_checks set finished_at = now(), outcome = 'error'
where id = $3::uuid and account_id = $1::uuid and reading_id = $2::uuid and finished_at is null`,
      params: [accountId, readingId, claimId],
    },
    settleStatusStatement(accountId, readingId),
  ];
}

// The commit (same shape as commitStatements in submit-answers-core.ts, so
// committedTry reads it): finish the live claim and insert the attempt in
// one statement, then the answers (only for this reading's questions),
// then settle the status. No challenge to close.
export function selfCommitStatements(input: SaveInput): Statement[] {
  const { studentId: accountId, readingId } = input;
  const result = input.passed ? "pass" : "fail";
  return [
    selfEffortLockStatement(readingId),
    {
      // $3 claim id, $4 attempt id, $5 result, $6 stale seconds, $7 tries.
      text: `with claim as (
  update self_effort_checks set finished_at = now(), outcome = $5::text
  where id = $3::uuid and account_id = $1::uuid and reading_id = $2::uuid
    and finished_at is null and created_at > now() - make_interval(secs => $6::int)
    and ${TRIES} < $7::int
    and ${NOT_PASSED}
  returning id
)
insert into self_attempts (id, account_id, reading_id, try_number, result)
select $4::uuid, $1::uuid, $2::uuid, ${TRIES} + 1, $5::text::attempt_result
from claim
returning try_number`,
      params: [accountId, readingId, input.claimId, input.attemptId, result, EFFORT_CLAIM_STALE_SECONDS, MAX_TRIES],
    },
    {
      // $3 attempt id, $4 to $7 the answers' question ids, texts, passes,
      // and nudges.
      text: `insert into self_answers (attempt_id, question_id, text, ai_pass, ai_feedback)
select $3::uuid, a.question_id, a.text, a.pass, nullif(a.nudge, '')
from unnest($4::uuid[], $5::text[], $6::boolean[], $7::text[]) as a(question_id, text, pass, nudge)
join self_questions q on q.id = a.question_id and q.reading_id = $2::uuid
where exists (select 1 from self_attempts where id = $3::uuid and account_id = $1::uuid)
returning id`,
      params: [
        accountId,
        readingId,
        input.attemptId,
        input.verdicts.map((v) => v.questionId),
        input.verdicts.map((v) => v.text),
        input.verdicts.map((v) => v.pass),
        input.verdicts.map((v) => v.nudge),
      ],
    },
    settleStatusStatement(accountId, readingId),
  ];
}

// The store submitAnswersWith runs on. Its "student" is the account.
export function postgresSelfAttemptStore(execute: StatementExecutor): AttemptStore {
  return {
    async loadContext(accountId, readingId) {
      return submitLookup(await execute(selfSubmitContextStatements(accountId, readingId)));
    },
    async claim(accountId, readingId, claimId) {
      return claimOutcome(await execute(selfClaimCheckStatements(accountId, readingId, claimId)));
    },
    async release(accountId, readingId, claimId) {
      await execute(selfReleaseCheckStatements(accountId, readingId, claimId));
    },
    async commit(input) {
      return committedTry(await execute(selfCommitStatements(input)));
    },
  };
}

// The tries with their answers, the limits, and the check count, in the
// shapes readingProgress reads (no challenge). The settle runs first, so a
// stale check left by a dead request can't keep a finished reading in
// progress.
export function selfProgressStatements(accountId: string, readingId: string): Statement[] {
  return [
    settleStatusStatement(accountId, readingId),
    {
      text: `select a.try_number, a.result,
  coalesce(
    json_agg(json_build_object(
      'question_id', an.question_id, 'text', an.text, 'pass', an.ai_pass, 'nudge', an.ai_feedback
    )) filter (where an.id is not null),
    '[]'::json
  ) as answers
from self_attempts a
left join self_answers an on an.attempt_id = a.id
where a.account_id = $1::uuid and a.reading_id = $2::uuid
group by a.id
order by a.try_number`,
      params: [accountId, readingId],
    },
    {
      text: `select null as status, null as extra_try, $1::int as tries_allowed, $2::int as checks_allowed`,
      params: [MAX_TRIES, EFFORT_CHECK_LIMIT],
    },
    {
      text: `select count(*)::int as checks from self_effort_checks where account_id = $1::uuid and reading_id = $2::uuid`,
      params: [accountId, readingId],
    },
  ];
}

export function selfProgress(results: Record<string, unknown>[][]): ReadingProgress {
  return readingProgress(results.slice(1));
}

// What the solo reading page shows under the questions. No challenge step:
// out of tries or out of checks is "moved_on".
export type SoloStage =
  | Extract<AnswerStage, { kind: "answer" }>
  | { kind: "passed"; attempt: AttemptView | null }
  | { kind: "moved_on"; attempt: AttemptView | null; reason: "tries" | "checks" };

export function soloStage(progress: ReadingProgress): SoloStage {
  const stage = answerStage({ ...progress, challenge: null });
  switch (stage.kind) {
    case "answer":
      return { ...stage, extraTry: false };
    case "passed":
      return { kind: "passed", attempt: stage.attempt };
    case "out_of_tries":
      return { kind: "moved_on", attempt: stage.attempt, reason: "tries" };
    case "check_limit":
      return { kind: "moved_on", attempt: stage.attempt, reason: "checks" };
    case "challenged":
      // Unreachable without a challenge; treated as done.
      return { kind: "moved_on", attempt: stage.attempt, reason: "tries" };
  }
}

export const SOLO_CHECKS_USED_MESSAGE = "We couldn’t check your answers this time. You can move on to a new reading.";

// For the live region after a check.
export function soloAnnouncement(stage: SoloStage): string {
  switch (stage.kind) {
    case "passed":
      return "You passed this reading. Nice work!";
    case "moved_on":
      return stage.reason === "tries"
        ? `That was try ${MAX_TRIES} of ${MAX_TRIES}. Read the tips, then move on when you’re ready.`
        : SOLO_CHECKS_USED_MESSAGE;
    case "answer":
      return stage.previous
        ? `Not yet. Read the tips and try again. This is try ${stage.tryNumber} of ${stage.maxTries}.`
        : "";
  }
}

// The message for every submit outcome that isn't a saved check or a form
// to fix. Same as a student's, except nobody to send a note to.
export function soloSubmitMessage(status: Exclude<SubmitResult["status"], "checked" | "invalid">): string {
  switch (status) {
    case "already_passed":
      return ALREADY_PASSED_MESSAGE;
    case "out_of_tries":
      return OUT_OF_TRIES_MESSAGE;
    case "busy":
      return CHECK_BUSY_MESSAGE;
    case "too_many_checks":
      return SOLO_CHECKS_USED_MESSAGE;
    case "check_failed":
      return CHECK_FAILED_MESSAGE;
    case "stale":
    case "not_found":
      return ANSWERS_STALE_MESSAGE;
  }
}
