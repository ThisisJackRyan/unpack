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
// A model call can't run inside a database transaction, so:
//
// 1. Load the reading (published, in the student's class), the student's
//    questions, and their tries so far. Refuse early when they already
//    passed or are out of tries, then validate the answers against exactly
//    these questions. Nothing is written yet, so a bad form costs nothing.
// 2. Claim, in ONE transaction under a transaction-scoped advisory lock on
//    (student, reading), the join-rate-limit pattern: insert an
//    effort_checks row only if the student has no passing attempt, fewer
//    attempts and effort_checks rows than their limits, and no live claim
//    (unfinished and younger than EFFORT_CLAIM_STALE_SECONDS). The lock makes those counts and the insert one
//    step, so 20 parallel submits get exactly one claim; the rest are told
//    "busy" (or the reason they can't go on).
// 3. Call the model with no transaction open.
// 4. Commit, in ONE transaction under the same lock: finish the claim and
//    insert the attempt (try_number = tries so far + 1) and its answers,
//    only while the claim is still live and the student still has fewer
//    attempts than their limit and no pass. The unique (student, reading,
//    try_number) constraint is the backstop. A passing attempt also closes
//    an open challenge in the same transaction (status closed), so the
//    teacher's queue never asks about a student who has since passed.
// 5. On a model error or timeout, finish the claim with no attempt: the try
//    isn't used up, but the effort_checks row still counts toward
//    EFFORT_CHECK_LIMIT, so a broken model can't be retried forever. Once
//    the limit is reached without a pass, the challenge opens (see
//    challenges-core.ts), so the limit never strands a student.
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
import type { EffortCheckInput, EffortVerdict } from "./ai/effort-check";
import type { GradeLevel } from "./grade-levels";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import { hasPgCode, isUniqueViolation } from "./pg-errors";
import { checksAllowedSql, effortLockStatement, limitsFromRow, triesAllowedSql } from "./reading-limits";
import type { StudentQuestion } from "./student-questions-core";
import {
  ANSWERS_STALE_MESSAGE,
  EFFORT_CHECK_LIMIT,
  validateAnswers,
  type AnswerEntry,
  type AnswerErrors,
  type ValidAnswer,
} from "./validate-answers";

// Defined in validate-answers.ts (see there); re-exported for callers that
// think of it as a submit rule.
export { EFFORT_CHECK_LIMIT };

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

export type SubmitContext = {
  bodyText: string;
  gradeLevel: GradeLevel;
  questions: StudentQuestion[];
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
  | "too_many_checks";

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
  claim(studentId: string, readingId: string, claimId: string): Promise<ClaimOutcome>;
  // Finishes the claim with no attempt (outcome "error").
  release(studentId: string, readingId: string, claimId: string): Promise<void>;
  // The saved try number, or null when the claim was no longer live.
  commit(input: SaveInput): Promise<number | null>;
};

export type EffortChecker = (input: EffortCheckInput) => Promise<EffortVerdict[]>;

export type SubmitDeps = {
  store: AttemptStore;
  check: EffortChecker;
  newId: () => string;
  // Logs safe fields only (never the text, answers, or names).
  onError?: (error: unknown) => void;
};

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
  | { status: "check_failed" };

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
  const lookup = await store.loadContext(studentId, readingId);
  if (lookup.status !== "ok") return { status: "not_found" };
  const { context } = lookup;
  if (context.passed) return { status: "already_passed" };
  if (context.tries >= context.triesAllowed) return { status: "out_of_tries" };
  if (context.questions.length === 0) return { status: "not_found" };

  const validation = validateAnswers(
    context.questions.map((q) => q.id),
    entries,
  );
  if (!validation.ok) {
    return validation.stale ? { status: "stale" } : { status: "invalid", errors: validation.errors };
  }
  const { answers } = validation;

  const claimId = deps.newId();
  const claim = await store.claim(studentId, readingId, claimId);
  if (claim !== "claimed") return { status: claim };

  const prompts = new Map(context.questions.map((q) => [q.id, q.prompt]));
  let results: AnswerResult[] | null;
  try {
    const verdicts = await deps.check({
      bodyText: context.bodyText,
      gradeLevel: context.gradeLevel,
      items: answers.map((a) => ({ questionId: a.questionId, question: prompts.get(a.questionId) ?? "", answer: a.text })),
    });
    results = matchVerdicts(answers, verdicts);
    if (!results) throw new Error("effort check returned the wrong answers");
  } catch (error) {
    deps.onError?.(error);
    await store.release(studentId, readingId, claimId);
    return { status: "check_failed" };
  }

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
  ];
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

const CHECKS = `(select count(*) from effort_checks where student_id = $1::uuid and reading_id = $2::uuid)`;

// The claim, as ONE READ COMMITTED transaction:
// 1. Lock (student, reading), so this student's submits for this reading
//    queue up here for a few milliseconds. A hashtext() collision only
//    makes two pairs share a lock (more queuing, never a wrong count).
// 2. Insert the claim only if every rule holds. This statement's fresh
//    snapshot, taken after the lock wait, sees every claim and attempt a
//    previous holder committed, so the counts are exact.
// 3. Say why when nothing was inserted.
export function claimStatements(studentId: string, readingId: string, claimId: string): Statement[] {
  return [
    effortLockStatement(studentId, readingId),
    {
      // $3 claim id, $4 stale seconds.
      text: `insert into effort_checks (id, student_id, reading_id)
select $3::uuid, $1::uuid, $2::uuid
where ${ELIGIBLE}
and ${NOT_PASSED}
and ${TRIES} < ${TRIES_ALLOWED}
and not ${liveClaim(4)}
and ${CHECKS} < ${CHECKS_ALLOWED}
returning id`,
      params: [studentId, readingId, claimId, EFFORT_CLAIM_STALE_SECONDS],
    },
    {
      // $3 stale seconds.
      text: `select ${ELIGIBLE} as eligible,
  not ${NOT_PASSED} as passed,
  ${TRIES}::int as tries,
  ${liveClaim(3)} as live,
  ${CHECKS}::int as checks,
  ${TRIES_ALLOWED} as tries_allowed,
  ${CHECKS_ALLOWED} as checks_allowed`,
      params: [studentId, readingId, EFFORT_CLAIM_STALE_SECONDS],
    },
  ];
}

// Reads the claim batch's results. The order matters: a student who no
// longer qualifies is "not_found"; a pass or the last try beats a busy
// check; a running check is "busy" even at the limit (it may still pass).
export function claimOutcome(results: Record<string, unknown>[][]): ClaimOutcome {
  if ((results[1]?.length ?? 0) > 0) return "claimed";
  const row = results[2]?.[0];
  if (row?.eligible !== true) return "not_found";
  const limits = limitsFromRow(row);
  if (row.passed === true) return "already_passed";
  if (Number(row.tries ?? 0) >= limits.tries) return "out_of_tries";
  if (row.live === true) return "busy";
  if (Number(row.checks ?? 0) >= limits.checks) return "too_many_checks";
  return "busy";
}

// Finishes a claim with no attempt, if it is still unfinished. $3 claim id.
export function releaseStatement(studentId: string, readingId: string, claimId: string): Statement {
  return {
    text: `update effort_checks set finished_at = now(), outcome = 'error'
where id = $3::uuid and student_id = $1::uuid and reading_id = $2::uuid and finished_at is null`,
    params: [studentId, readingId, claimId],
  };
}

// The commit, as ONE transaction:
// 1. The same lock as the claim.
// 2. Finish the claim and insert the attempt, in one statement: the update
//    only matches while the claim is still live and the student still has
//    fewer attempts than their limit and no pass, and the insert only runs
//    for the row it returned.
// 3. Insert the answers, only for the attempt just saved, and only for
//    questions of this student's set.
// 4. If that attempt passed, close any open challenge (status closed, no
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
    {
      // $3 attempt id, $4 to $7 the answers' question ids, texts, passes,
      // and nudges.
      text: `insert into answers (attempt_id, question_id, text, ai_pass, ai_feedback)
select $3::uuid, a.question_id, a.text, a.pass, nullif(a.nudge, '')
from unnest($4::uuid[], $5::text[], $6::boolean[], $7::text[]) as a(question_id, text, pass, nudge)
join questions q on q.id = a.question_id and q.reading_id = $2::uuid
  and (q.student_id is null or q.student_id = $1::uuid)
where exists (select 1 from attempts where id = $3::uuid)
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

// Step 4 of the commit. $3 attempt id: only an attempt saved in this
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
    async claim(studentId, readingId, claimId) {
      return claimOutcome(await execute(claimStatements(studentId, readingId, claimId)));
    },
    async release(studentId, readingId, claimId) {
      await execute([releaseStatement(studentId, readingId, claimId)]);
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
    case "stale":
    case "not_found":
      return ANSWERS_STALE_MESSAGE;
  }
}
