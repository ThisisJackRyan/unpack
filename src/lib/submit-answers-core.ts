// A student submits their answers to a reading: validate, claim, one effort
// check (a model call), save the attempt. Pure logic over an injected store
// and checker, so tests run it with fakes; postgresAttemptStore turns an
// executor into the real store (the server-only runner is
// submit-answers.ts).
//
// Race safety and cost: a student can double-click, open two tabs, or
// script the form, and every check is a paid model call. The rules: at
// most MAX_TRIES attempts, nothing after a pass, one check running at a
// time, and at most EFFORT_CHECK_LIMIT checks ever per student per reading.
// A teacher's "one more try" raises both limits for that student (see
// reading-limits.ts); every rule below uses the student's own limits.
//
// Passed answers are locked (the v1 spec's rule): a question that passed
// on the latest try stays passed, with its answer as it was. A later try
// sends, checks, and saves only the questions that are not yet passed;
// the commit copies the locked answers into the new try from the
// database (never from the form), so every try holds every question and
// the latest try always says where things stand. The try passes once its
// own answers all pass (the locked ones already did). "Passed" is derived
// from the saved answers, so there is no extra column: a question can
// only stop being locked if the latest try lost it, and no try does.
// A model call can't run inside a database transaction, so:
//
// 1. Load the reading (published, in the student's class), the student's
//    questions, and their tries so far. Refuse early when they already
//    passed or are out of tries, then validate the answers against exactly
//    the questions that are not locked (a locked question's answer in the
//    form, crafted or from an old tab, makes it "stale"). Nothing is
//    written yet, so a bad form costs nothing.
// 2. Claim, in ONE transaction under a transaction-scoped advisory lock on
//    (student, reading), the join-rate-limit pattern: insert an
//    effort_checks row only if the student has no passing attempt, fewer
//    attempts and effort_checks rows than their limits, and no live claim
//    (unfinished and younger than EFFORT_CLAIM_STALE_SECONDS), and still
//    exactly the tries the answers were validated against (another tab
//    may have saved a try since, which may have locked more questions:
//    then "stale"). The lock makes those counts and the insert one
//    step, so 20 parallel submits get exactly one claim; the rest are told
//    "busy" (or the reason they can't go on). While the claim is live no
//    other claim or commit can happen, so the locked set can't change
//    before this commit.
// 3. Call the model with no transaction open.
// 4. Commit, in ONE transaction under the same lock: finish the claim and
//    insert the attempt (try_number = tries so far + 1) and its answers,
//    only while the claim is still live and the student still has fewer
//    attempts than their limit and no pass. The unique (student, reading,
//    try_number) constraint is the backstop. The locked answers are copied
//    from the previous try first, and the new answers are inserted with
//    "on conflict do nothing", so a locked answer is never replaced. A
//    passing attempt also closes
//    an open challenge in the same transaction (status closed), so the
//    teacher's queue never asks about a student who has since passed.
// 5. On a model error or timeout, finish the claim with no attempt: the try
//    isn't used up. A timeout (EFFORT_CHECK_DEADLINE_MS, or a per-request
//    timeout that ended the call) is reported as "timed_out", anything
//    else as "check_failed", so the student is told which. Whether the
//    check still counts toward EFFORT_CHECK_LIMIT depends on whether the
//    model replied (effortFailureCounts), for a timeout too (a reply, then
//    a retry that ran out of time): "timed_out" says so (`counted`), since
//    a counted check can be the last one and the page then moves on.
//    - It replied, but not usably (no tool call, the wrong answers, a
//      refusal): outcome "error", and it counts, so a model that keeps
//      answering badly can't be retried forever. Once the limit is reached
//      without a pass, the challenge opens (see challenges-core.ts), so the
//      limit never strands a student.
//    - No reply at all (not set up, out of credits (402), any other
//      gateway refusal, an outage or 5xx, a network error, or a timeout):
//      outcome "given_back". That's our setup's or the provider's fault,
//      not the student's, so it doesn't count toward the limit. It counts
//      toward a short window instead: once a student has
//      EFFORT_GIVEN_BACK_WINDOW_LIMIT given-back checks on a reading in the
//      last EFFORT_GIVEN_BACK_WINDOW_MINUTES, the claim refuses ("paused")
//      until the oldest leaves the window, so an outage can't be hammered
//      (a timed-out call may still be billed). The claim counts them under
//      the same lock, so the window is exact. Only checks that failed with
//      no reply are ever marked, so the checks the model answered are never
//      undercounted.
// 6. When the commit throws, finish the claim the same way, best effort,
//    so the student isn't told "busy" for EFFORT_CLAIM_STALE_SECONDS. The
//    release only touches an unfinished claim, so if the commit did land
//    (a network error after COMMIT, say) the saved try stands. The check
//    still counts toward the limit: the model was paid for, and a commit
//    that fails every time (a bad row, a schema mismatch) would otherwise
//    be an unbounded loop of paid checks. At the limit the challenge opens,
//    so counting it costs the student little. Then the original error
//    propagates (fail closed).
//
// A claim left unfinished (a killed function, say) stops blocking once it
// is EFFORT_CLAIM_STALE_SECONDS old; it still counts toward the limit. Its
// holder, if it ever wakes up, fails the liveness check and saves nothing.
// Every database error propagates, so the caller fails closed.

import { EFFORT_CHECK_DEADLINE_MS } from "./ai/settings";
import { withDeadline } from "./deadline";
import { EffortCheckError, effortErrorKind, type EffortCheckInput, type EffortVerdict } from "./ai/effort-check";
import type { GradeLevel } from "./grade-levels";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import { dateFromRow } from "./local-time";
import { hasPgCode, isUniqueViolation } from "./pg-errors";
import { checksAllowedSql, countedCheckSql, effortLockStatement, limitsFromRow, triesAllowedSql } from "./reading-limits";
import type { StudentQuestion } from "./student-questions-core";
import {
  ANSWERS_STALE_MESSAGE,
  CHECK_TIMED_OUT_MESSAGE,
  EFFORT_CHECK_LIMIT,
  validateAnswers,
  type AnswerEntry,
  type AnswerErrors,
  type ValidAnswer,
} from "./validate-answers";

// Defined in validate-answers.ts (see there); re-exported for callers that
// think of them as submit rules.
export { CHECK_TIMED_OUT_MESSAGE, EFFORT_CHECK_LIMIT };

// Longer than the most a check can take (the deadline ends it, validation
// retry, SDK retries, and backoff included), plus 30s for the commit and
// slow starts, so a live check is never treated as stale: 90s.
export const EFFORT_CLAIM_STALE_SECONDS = Math.ceil(EFFORT_CHECK_DEADLINE_MS / 1000) + 30;

export const ALREADY_PASSED_MESSAGE = "You already passed this one. Nice work!";
export const OUT_OF_TRIES_MESSAGE = "You’ve used all your tries on this one.";
export const CHECK_BUSY_MESSAGE = "We’re still checking your answers. Wait a moment, then try again.";
// The page moves to the note to the teacher (answerStage's check_limit).
export const TOO_MANY_CHECKS_MESSAGE = "We couldn’t check your answers. Send a note to your teacher.";
// Calm on purpose: during an outage, quick retries only use up checks.
export const CHECK_FAILED_MESSAGE =
  "We couldn’t check your answers just now. Wait a minute, then try again. This didn’t use up a try.";
// "paused": checking has failed a few times in a row (an outage). The
// time it frees up is added after (see retryAtSentence).
export const CHECKS_PAUSED_MESSAGE =
  "Checking answers isn’t working right now, so let’s take a short break. This didn’t use up a try.";

// The outage window for given-back checks (see step 5 above): 3 in 10
// minutes per student per reading, room for a blip and a retry or two.
export const EFFORT_GIVEN_BACK_WINDOW_LIMIT = 3;
export const EFFORT_GIVEN_BACK_WINDOW_MINUTES = 10;

export type SubmitContext = {
  bodyText: string;
  gradeLevel: GradeLevel;
  questions: StudentQuestion[];
  // The questions that passed on the latest try: locked (see above).
  lockedQuestionIds: string[];
  tries: number;
  // MAX_TRIES, or more after a teacher's "one more try".
  triesAllowed: number;
  passed: boolean;
};

export type SubmitLookup = { status: "ok"; context: SubmitContext } | { status: "not_found" };

// Why a claim was or wasn't made, most important reason first.
export type ClaimOutcome =
  | "claimed"
  | "not_found"
  | "already_passed"
  | "out_of_tries"
  | "busy"
  // Another try was saved since the answers were validated.
  | "stale"
  | "too_many_checks"
  // EFFORT_GIVEN_BACK_WINDOW_LIMIT given-back checks in the window.
  | "paused";

export type SaveInput = {
  studentId: string;
  readingId: string;
  claimId: string;
  attemptId: string;
  passed: boolean;
  verdicts: { questionId: string; text: string; pass: boolean; nudge: string }[];
};

export type AttemptStore = {
  loadContext(studentId: string, readingId: string): Promise<SubmitLookup>;
  // `expectedTries`: the tries the answers were validated against; any
  // other count is "stale".
  claim(studentId: string, readingId: string, claimId: string, expectedTries: number): Promise<ClaimOutcome>;
  // Finishes the claim with no attempt: outcome "given_back" when
  // givenBack (the model never replied), else "error".
  release(studentId: string, readingId: string, claimId: string, givenBack?: boolean): Promise<void>;
  // When the next check frees up after "paused" (the oldest given-back
  // check in the window, plus the window), if the store can say.
  pausedUntil?(studentId: string, readingId: string): Promise<Date | null>;
  // The saved try number, or null when the claim was no longer live.
  commit(input: SaveInput): Promise<number | null>;
};

export type EffortCheckHooks = {
  // Called each time the model replies (see checkEffort's option).
  onModelResponse: () => void;
};

export type EffortChecker = (input: EffortCheckInput, hooks?: EffortCheckHooks) => Promise<EffortVerdict[]>;

export type SubmitDeps = {
  store: AttemptStore;
  check: EffortChecker;
  newId: () => string;
  // Logs safe fields only (never the text, answers, or names).
  onError?: (error: unknown) => void;
  // Bounds the lookup before the claim (see answer-check-guard.ts): past
  // it, a DeadlineError, and nothing was written.
  preCheck?: AbortSignal;
};

// Only the questions checked on this try (not the locked ones).
export type AnswerResult = { questionId: string; pass: boolean; nudge: string };

export type SubmitResult =
  | { status: "checked"; passed: boolean; tryNumber: number; results: AnswerResult[] }
  | { status: "invalid"; errors: AnswerErrors }
  | { status: "stale" }
  | { status: "not_found" }
  | { status: "already_passed" }
  | { status: "out_of_tries" }
  | { status: "busy" }
  | { status: "too_many_checks" }
  | { status: "paused"; retryAt: Date | null }
  | { status: "check_failed" }
  // `counted`: the model replied before the deadline, so the check counts
  // toward the limit (step 5) and may have been the last one.
  | { status: "timed_out"; counted: boolean };

// Whether a failed check counts toward EFFORT_CHECK_LIMIT (step 5 above):
// only when the model replied at least once. Unusable output is only ever
// thrown after a reply, so it counts even from a checker that doesn't
// report replies.
export function effortFailureCounts(error: unknown, modelResponded: boolean): boolean {
  if (modelResponded) return true;
  return error instanceof EffortCheckError && error.kind === "failed";
}

// The model must return one verdict per answer, in order; checkEffort
// guarantees it, and this holds the line for any other checker.
function matchVerdicts(answers: ValidAnswer[], verdicts: EffortVerdict[]): AnswerResult[] | null {
  if (verdicts.length !== answers.length) return null;
  const results: AnswerResult[] = [];
  for (let i = 0; i < answers.length; i++) {
    const v = verdicts[i];
    if (v.questionId !== answers[i].questionId) return null;
    results.push({ questionId: v.questionId, pass: v.pass, nudge: v.pass ? "" : v.nudge });
  }
  return results;
}

export async function submitAnswersWith(
  studentId: string,
  readingId: string,
  entries: AnswerEntry[],
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const { store } = deps;
  const lookup = await withDeadline(store.loadContext(studentId, readingId), deps.preCheck);
  if (lookup.status !== "ok") return { status: "not_found" };
  const { context } = lookup;
  if (context.passed) return { status: "already_passed" };
  if (context.tries >= context.triesAllowed) return { status: "out_of_tries" };
  if (context.questions.length === 0) return { status: "not_found" };
  const locked = new Set(context.lockedQuestionIds);
  const open = context.questions.filter((q) => !locked.has(q.id));
  // Every question locked without a passing try can't happen (a try whose
  // answers all pass is a pass); refuse rather than check nothing.
  if (open.length === 0) return { status: "stale" };

  const validation = validateAnswers(
    open.map((q) => q.id),
    entries,
  );
  if (!validation.ok) {
    return validation.stale ? { status: "stale" } : { status: "invalid", errors: validation.errors };
  }
  const { answers } = validation;

  const claimId = deps.newId();
  const claim = await store.claim(studentId, readingId, claimId, context.tries);
  if (claim === "paused") {
    return { status: "paused", retryAt: (await store.pausedUntil?.(studentId, readingId)) ?? null };
  }
  if (claim !== "claimed") return { status: claim };

  const prompts = new Map(context.questions.map((q) => [q.id, q.prompt]));
  let results: AnswerResult[] | null;
  let modelResponded = false;
  try {
    const verdicts = await deps.check(
      {
        bodyText: context.bodyText,
        gradeLevel: context.gradeLevel,
        items: answers.map((a) => ({ questionId: a.questionId, question: prompts.get(a.questionId) ?? "", answer: a.text })),
      },
      { onModelResponse: () => (modelResponded = true) },
    );
    // Verdicts came back, so a reply did too.
    modelResponded = true;
    results = matchVerdicts(answers, verdicts);
    if (!results) throw new Error("effort check returned the wrong answers");
  } catch (error) {
    deps.onError?.(error);
    const counted = effortFailureCounts(error, modelResponded);
    await store.release(studentId, readingId, claimId, !counted);
    return effortErrorKind(error) === "timeout" ? { status: "timed_out", counted } : { status: "check_failed" };
  }

  // The locked questions passed already, so the try passes when every
  // question checked now does.
  const passed = results.every((r) => r.pass);
  const texts = new Map(answers.map((a) => [a.questionId, a.text]));
  let tryNumber: number | null;
  try {
    tryNumber = await store.commit({
      studentId,
      readingId,
      claimId,
      attemptId: deps.newId(),
      passed,
      verdicts: results.map((r) => ({ ...r, text: texts.get(r.questionId) ?? "" })),
    });
  } catch (error) {
    // Finish the claim so it stops blocking (step 6 above). A unique or
    // check violation rolled the commit back, claim and all: report a
    // failed check. Any other error propagates (fail closed).
    const conflict = isUniqueViolation(error) || hasPgCode(error, "23514");
    if (conflict) deps.onError?.(error);
    try {
      await store.release(studentId, readingId, claimId);
    } catch (releaseError) {
      // The claim goes stale on its own; the commit's error matters more.
      deps.onError?.(releaseError);
    }
    if (!conflict) throw error;
    return { status: "check_failed" };
  }
  if (tryNumber === null) return { status: "check_failed" };
  return { status: "checked", passed, tryNumber, results };
}

// Statements for the Postgres store, kept here so tests can check them.
// $1 student, $2 reading throughout.

// The reading (published, in the student's class), with its effective
// grade; the student's questions (the shared set, or their own set in
// per-student mode); their tries so far; and their try limit.
export function submitContextStatements(studentId: string, readingId: string): Statement[] {
  return [
    {
      text: `select r.body_text, coalesce(r.grade_level, c.grade_level) as grade_level, r.question_mode
from readings r
join classes c on c.id = r.class_id
join students s on s.class_id = r.class_id and s.id = $1::uuid
where r.id = $2::uuid and r.status = 'published'`,
      params: [studentId, readingId],
    },
    {
      text: `select q.id, q.position, q.prompt
from questions q
join readings r on r.id = q.reading_id
where q.reading_id = $2::uuid
  and q.student_id is not distinct from (
    case when r.question_mode = 'per_student' then $1::uuid end
  )
order by q.position`,
      params: [studentId, readingId],
    },
    {
      text: `select count(*)::int as tries, coalesce(bool_or(result = 'pass'), false) as passed,
  ${TRIES_ALLOWED} as tries_allowed
from attempts where student_id = $1::uuid and reading_id = $2::uuid`,
      params: [studentId, readingId],
    },
    lockedStatement(studentId, readingId),
  ];
}

// Where a reader's tries and answers live: the class tables, or the
// self-learner ones (owned by an account).
export type AnswerTables = {
  answers: "answers" | "self_answers";
  attempts: "attempts" | "self_attempts";
  owner: "student_id" | "account_id";
};
export const CLASS_ANSWER_TABLES: AnswerTables = { answers: "answers", attempts: "attempts", owner: "student_id" };
export const SELF_ANSWER_TABLES: AnswerTables = { answers: "self_answers", attempts: "self_attempts", owner: "account_id" };

// The locked questions: those that passed on the latest try. Shared with
// the self-learner store. $1 owner, $2 reading.
export function lockedStatement(
  ownerId: string,
  readingId: string,
  tables: AnswerTables = CLASS_ANSWER_TABLES,
): Statement {
  return {
    text: `select an.question_id from ${tables.answers} an
where an.ai_pass and an.attempt_id = (
  select a.id from ${tables.attempts} a
  where a.${tables.owner} = $1::uuid and a.reading_id = $2::uuid
  order by a.try_number desc limit 1
)`,
    params: [ownerId, readingId],
  };
}

export function submitLookup(results: Record<string, unknown>[][]): SubmitLookup {
  const reading = results[0]?.[0];
  if (!reading) return { status: "not_found" };
  const progress = results[2]?.[0];
  return {
    status: "ok",
    context: {
      bodyText: String(reading.body_text),
      gradeLevel: reading.grade_level as GradeLevel,
      questions: (results[1] ?? []).map((q) => ({
        id: String(q.id),
        position: Number(q.position),
        prompt: String(q.prompt),
      })),
      lockedQuestionIds: (results[3] ?? []).map((row) => String(row.question_id)),
      tries: Number(progress?.tries ?? 0),
      triesAllowed: limitsFromRow(progress).tries,
      passed: progress?.passed === true,
    },
  };
}

// The conditions every claim and commit re-checks under the lock.
const ELIGIBLE = `exists (
  select 1 from readings r join students s on s.class_id = r.class_id
  where r.id = $2::uuid and s.id = $1::uuid and r.status = 'published'
)`;
const NOT_PASSED = `not exists (
  select 1 from attempts where student_id = $1::uuid and reading_id = $2::uuid and result = 'pass'
)`;
const TRIES = `(select count(*) from attempts where student_id = $1::uuid and reading_id = $2::uuid)`;
// The student's limits (MAX_TRIES and EFFORT_CHECK_LIMIT unless a teacher
// granted one more try).
const TRIES_ALLOWED = triesAllowedSql("$1::uuid", "$2::uuid");
const CHECKS_ALLOWED = checksAllowedSql("$1::uuid", "$2::uuid");

// Whether a check is running: an unfinished claim younger than the stale
// timeout, given as parameter $n.
function liveClaim(n: number): string {
  return `exists (
  select 1 from effort_checks
  where student_id = $1::uuid and reading_id = $2::uuid
    and finished_at is null and created_at > now() - make_interval(secs => $${n}::int)
)`;
}

// The checks that count toward the limit: every one the model answered.
const CHECKS = `(select count(*) from effort_checks where student_id = $1::uuid and reading_id = $2::uuid and ${countedCheckSql()})`;

// The given-back checks in the outage window ($n: its minutes).
function givenBackRecent(n: number): string {
  return `(select count(*) from effort_checks
  where student_id = $1::uuid and reading_id = $2::uuid and outcome = 'given_back'
    and created_at > now() - make_interval(mins => $${n}::int))`;
}

// The claim, as ONE READ COMMITTED transaction:
// 1. Lock (student, reading), so this student's submits for this reading
//    queue up here for a few milliseconds. A hashtext() collision only
//    makes two pairs share a lock (more queuing, never a wrong count).
// 2. Insert the claim only if every rule holds. This statement's fresh
//    snapshot, taken after the lock wait, sees every claim and attempt a
//    previous holder committed, so the counts are exact.
// 3. Say why when nothing was inserted.
export function claimStatements(studentId: string, readingId: string, claimId: string, expectedTries: number): Statement[] {
  return [
    effortLockStatement(studentId, readingId),
    {
      // $3 claim id, $4 stale seconds, $5 window minutes, $6 window limit,
      // $7 the tries the answers were validated against.
      text: `insert into effort_checks (id, student_id, reading_id)
select $3::uuid, $1::uuid, $2::uuid
where ${ELIGIBLE}
and ${NOT_PASSED}
and ${TRIES} < ${TRIES_ALLOWED}
and ${TRIES} = $7::int
and not ${liveClaim(4)}
and ${CHECKS} < ${CHECKS_ALLOWED}
and ${givenBackRecent(5)} < $6::int
returning id`,
      params: [
        studentId,
        readingId,
        claimId,
        EFFORT_CLAIM_STALE_SECONDS,
        EFFORT_GIVEN_BACK_WINDOW_MINUTES,
        EFFORT_GIVEN_BACK_WINDOW_LIMIT,
        expectedTries,
      ],
    },
    {
      // $3 stale seconds, $4 window minutes.
      text: `select ${ELIGIBLE} as eligible,
  not ${NOT_PASSED} as passed,
  ${TRIES}::int as tries,
  ${liveClaim(3)} as live,
  ${CHECKS}::int as checks,
  ${TRIES_ALLOWED} as tries_allowed,
  ${CHECKS_ALLOWED} as checks_allowed,
  ${givenBackRecent(4)}::int as given_back_recent`,
      params: [studentId, readingId, EFFORT_CLAIM_STALE_SECONDS, EFFORT_GIVEN_BACK_WINDOW_MINUTES],
    },
  ];
}

// Reads the claim batch's results. The order matters: a student who no
// longer qualifies is "not_found"; a pass or the last try beats a busy
// check; a running check is "busy" even at the limit (it may still pass);
// then a try saved since the answers were validated is "stale".
export function claimOutcome(results: Record<string, unknown>[][], expectedTries?: number): ClaimOutcome {
  if ((results[1]?.length ?? 0) > 0) return "claimed";
  const row = results[2]?.[0];
  if (row?.eligible !== true) return "not_found";
  const limits = limitsFromRow(row);
  if (row.passed === true) return "already_passed";
  if (Number(row.tries ?? 0) >= limits.tries) return "out_of_tries";
  if (row.live === true) return "busy";
  if (expectedTries !== undefined && Number(row.tries ?? 0) !== expectedTries) return "stale";
  if (Number(row.checks ?? 0) >= limits.checks) return "too_many_checks";
  if (Number(row.given_back_recent ?? 0) >= EFFORT_GIVEN_BACK_WINDOW_LIMIT) return "paused";
  return "busy";
}

// Finishes a claim with no attempt, if it is still unfinished: given back
// ($4) when the model never replied, else an error. $3 claim id.
export function releaseStatement(studentId: string, readingId: string, claimId: string, givenBack = false): Statement {
  return {
    text: `update effort_checks set finished_at = now(),
  outcome = case when $4::boolean then 'given_back' else 'error' end
where id = $3::uuid and student_id = $1::uuid and reading_id = $2::uuid and finished_at is null`,
    params: [studentId, readingId, claimId, givenBack],
  };
}

// When the next check frees up: the oldest given-back check in the window,
// plus the window. Null when none is in the window. Shared with the
// self-learner store (`table` is effort_checks or self_effort_checks, and
// `owner` its student or account column). $1 owner, $2 reading.
export function pausedUntilStatement(
  ownerId: string,
  readingId: string,
  table: "effort_checks" | "self_effort_checks" = "effort_checks",
  owner: "student_id" | "account_id" = "student_id",
): Statement {
  return {
    text: `select min(created_at) + make_interval(mins => $3::int) as retry_at
from ${table}
where ${owner} = $1::uuid and reading_id = $2::uuid and outcome = 'given_back'
  and created_at > now() - make_interval(mins => $3::int)`,
    params: [ownerId, readingId, EFFORT_GIVEN_BACK_WINDOW_MINUTES],
  };
}

export function retryAtFromRows(results: Record<string, unknown>[][]): Date | null {
  return dateFromRow(results[0]?.[0]?.retry_at);
}

// The commit, as ONE transaction:
// 1. The same lock as the claim.
// 2. Finish the claim and insert the attempt, in one statement: the update
//    only matches while the claim is still live and the student still has
//    fewer attempts than their limit and no pass, and the insert only runs
//    for the row it returned.
// 3. Copy the locked answers (passed on the previous try) into it, as they
//    were (text, a pass, no nudge), from the database.
// 4. Insert the answers, only for the attempt just saved, and only for
//    questions of this student's set; never over a locked one (on
//    conflict do nothing).
// 5. If that attempt passed, close any open challenge (status closed, no
//    resolved_by): Passed beats Challenged, and the teacher has nothing
//    left to decide.
export function commitStatements(input: SaveInput): Statement[] {
  const { studentId, readingId } = input;
  const result = input.passed ? "pass" : "fail";
  return [
    effortLockStatement(studentId, readingId),
    {
      // $3 claim id, $4 attempt id, $5 result, $6 stale seconds.
      text: `with claim as (
  update effort_checks set finished_at = now(), outcome = $5::text
  where id = $3::uuid and student_id = $1::uuid and reading_id = $2::uuid
    and finished_at is null and created_at > now() - make_interval(secs => $6::int)
    and ${TRIES} < ${TRIES_ALLOWED}
    and ${NOT_PASSED}
  returning id
)
insert into attempts (id, student_id, reading_id, try_number, result)
select $4::uuid, $1::uuid, $2::uuid, ${TRIES} + 1, $5::text::attempt_result
from claim
returning try_number`,
      params: [
        studentId,
        readingId,
        input.claimId,
        input.attemptId,
        result,
        EFFORT_CLAIM_STALE_SECONDS,
      ],
    },
    carryLockedStatement(studentId, readingId, input.attemptId),
    {
      // $3 attempt id, $4 to $7 the answers' question ids, texts, passes,
      // and nudges.
      text: `insert into answers (attempt_id, question_id, text, ai_pass, ai_feedback)
select $3::uuid, a.question_id, a.text, a.pass, nullif(a.nudge, '')
from unnest($4::uuid[], $5::text[], $6::boolean[], $7::text[]) as a(question_id, text, pass, nudge)
join questions q on q.id = a.question_id and q.reading_id = $2::uuid
  and (q.student_id is null or q.student_id = $1::uuid)
where exists (select 1 from attempts where id = $3::uuid)
on conflict (attempt_id, question_id) do nothing
returning id`,
      params: [
        studentId,
        readingId,
        input.attemptId,
        input.verdicts.map((v) => v.questionId),
        input.verdicts.map((v) => v.text),
        input.verdicts.map((v) => v.pass),
        input.verdicts.map((v) => v.nudge),
      ],
    },
    autoCloseStatement(studentId, readingId, input.attemptId),
  ];
}

// Step 3 of the commit: the passing answers of the try before the one just
// saved ($3), copied into it. Only runs for an attempt saved in this
// transaction. Shared with the self-learner store (see lockedStatement).
export function carryLockedStatement(
  ownerId: string,
  readingId: string,
  attemptId: string,
  tables: AnswerTables = CLASS_ANSWER_TABLES,
): Statement {
  return {
    text: `insert into ${tables.answers} (attempt_id, question_id, text, ai_pass, ai_feedback)
select $3::uuid, p.question_id, p.text, true, null
from ${tables.answers} p
where p.ai_pass and p.attempt_id = (
  select a.id from ${tables.attempts} a
  where a.${tables.owner} = $1::uuid and a.reading_id = $2::uuid and a.id <> $3::uuid
  order by a.try_number desc limit 1
)
and exists (select 1 from ${tables.attempts} where id = $3::uuid and ${tables.owner} = $1::uuid and reading_id = $2::uuid)
returning question_id`,
    params: [ownerId, readingId, attemptId],
  };
}

// Step 5 of the commit. $3 attempt id: only an attempt saved in this
// transaction, and only a pass, closes the challenge.
export function autoCloseStatement(studentId: string, readingId: string, attemptId: string): Statement {
  return {
    text: `update challenges set status = 'closed', resolved_at = now()
where student_id = $1::uuid and reading_id = $2::uuid and status = 'open'
  and exists (
    select 1 from attempts
    where id = $3::uuid and student_id = $1::uuid and reading_id = $2::uuid and result = 'pass'
  )
returning id`,
    params: [studentId, readingId, attemptId],
  };
}

export function committedTry(results: Record<string, unknown>[][]): number | null {
  const row = results[1]?.[0];
  return row ? Number(row.try_number) : null;
}

export function postgresAttemptStore(execute: StatementExecutor): AttemptStore {
  return {
    async loadContext(studentId, readingId) {
      return submitLookup(await execute(submitContextStatements(studentId, readingId)));
    },
    async claim(studentId, readingId, claimId, expectedTries) {
      return claimOutcome(await execute(claimStatements(studentId, readingId, claimId, expectedTries)), expectedTries);
    },
    async release(studentId, readingId, claimId, givenBack) {
      await execute([releaseStatement(studentId, readingId, claimId, givenBack)]);
    },
    async pausedUntil(studentId, readingId) {
      return retryAtFromRows(await execute([pausedUntilStatement(studentId, readingId)]));
    },
    async commit(input) {
      return committedTry(await execute(commitStatements(input)));
    },
  };
}

// The student-facing message for every outcome that isn't a saved check or
// a form to fix.
export function submitMessage(status: Exclude<SubmitResult["status"], "checked" | "invalid">): string {
  switch (status) {
    case "already_passed":
      return ALREADY_PASSED_MESSAGE;
    case "out_of_tries":
      return OUT_OF_TRIES_MESSAGE;
    case "busy":
      return CHECK_BUSY_MESSAGE;
    case "too_many_checks":
      return TOO_MANY_CHECKS_MESSAGE;
    case "check_failed":
      return CHECK_FAILED_MESSAGE;
    case "timed_out":
      return CHECK_TIMED_OUT_MESSAGE;
    case "paused":
      return CHECKS_PAUSED_MESSAGE;
    case "stale":
    case "not_found":
      return ANSWERS_STALE_MESSAGE;
  }
}
