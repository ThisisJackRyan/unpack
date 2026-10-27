// A student's challenge (a review request to their teacher) after their
// last failed try, or once every effort check is used up without a pass.
// Pure statements and flow over an injected executor, so tests run it
// with fakes; the server-only runner is challenges.ts.
//
// One open challenge per student per reading, in rounds: round 1 is the
// first note. A teacher who denies it with "Give one more try" lets the
// student answer once more (see reading-limits.ts); if that try fails too,
// they can send a new note, which is a new row with round + 1. Earlier
// rounds stay as decided, for the record.
//
// The insert is ONE transaction under the same advisory lock as the
// submit claim and commit (submit-answers-core.ts), and conditional: the
// reading is published and in the student's class, no pass, no open or
// approved challenge and no denial without one more try, the student is
// out of tries or checks (their own limits), and no effort check is
// running. That last rule closes a second-tab race: at the check limit,
// the last check still running counts toward the limit, so without it a
// second tab could send a note while that check was about to save a pass.
// Now the note waits until the check is done ("busy").
//
// The unique (student_id, reading_id, round) constraint is the backstop:
// the lock already makes 20 parallel sends save exactly one (the rest see
// it and are told "already sent"), and a 23505 there means the same. Only
// the note is stored, with the ids and status: minimal data.

import type { Statement, StatementExecutor } from "./link-rate-limit";
import { isUniqueViolation } from "./pg-errors";
import { checksAllowedSql, effortLockStatement, limitsFromRow, triesAllowedSql } from "./reading-limits";
import { EFFORT_CLAIM_STALE_SECONDS } from "./submit-answers-core";
import { MAX_TRIES, validateChallengeNote } from "./validate-answers";

export const CHALLENGE_UNIQUE_CONSTRAINT = "challenges_student_reading_round_unique";

export const CHALLENGE_SENT_MESSAGE = "Sent! Your teacher will take a look.";
export const CHALLENGE_ALREADY_SENT_MESSAGE = "You already sent a note. Your teacher will take a look.";
export const CHALLENGE_NOT_READY_MESSAGE = `You can send a note after ${MAX_TRIES} tries.`;
export const CHALLENGE_PASSED_MESSAGE = "You already passed this one. Nice work!";
export const CHALLENGE_BUSY_MESSAGE = "We’re still checking your answers. Try again in a minute.";
export const CHALLENGE_FAILED_MESSAGE = "We couldn’t send your note. Try again.";

export type ChallengeResult =
  | { status: "sent" }
  | { status: "already_sent" }
  | { status: "invalid"; error: string }
  // Tries and checks left (the student's own limits).
  | { status: "not_ready" }
  // Approved, or the student passed.
  | { status: "already_passed" }
  // The teacher denied the last note without one more try. Never shown as
  // a message: the action refreshes the page, which shows "Your teacher
  // read your note." in place of the form.
  | { status: "decided" }
  // An effort check is still running for this student and reading.
  | { status: "busy" }
  | { status: "not_found" };

const ELIGIBLE = `exists (
  select 1 from readings r join students s on s.class_id = r.class_id
  where r.id = $2::uuid and s.id = $1::uuid and r.status = 'published'
)`;
const FAILS = `(select count(*) from attempts
  where student_id = $1::uuid and reading_id = $2::uuid and result = 'fail')`;
const PASSED = `exists (
  select 1 from attempts where student_id = $1::uuid and reading_id = $2::uuid and result = 'pass'
)`;
// Every effort check started, failed ones included (the same count the
// claim in submit-answers-core.ts limits).
const CHECKS = `(select count(*) from effort_checks where student_id = $1::uuid and reading_id = $2::uuid)`;
const TRIES_ALLOWED = triesAllowedSql("$1::uuid", "$2::uuid");
const CHECKS_ALLOWED = checksAllowedSql("$1::uuid", "$2::uuid");
// A challenge that blocks a new one: open, approved, closed (the student
// passed), or denied without one more try. Only a round denied with one
// more try lets the student send another note, once out of tries again.
const BLOCKING = `exists (
  select 1 from challenges where student_id = $1::uuid and reading_id = $2::uuid
    and (status <> 'denied' or tries_allowed is null)
)`;
// An unfinished effort check younger than the stale timeout (parameter
// $n), as in submit-answers-core.ts.
function live(n: number): string {
  return `exists (
  select 1 from effort_checks
  where student_id = $1::uuid and reading_id = $2::uuid
    and finished_at is null and created_at > now() - make_interval(secs => $${n}::int)
)`;
}

// The send, as ONE READ COMMITTED transaction:
// 1. The student's (student, reading) advisory lock, shared with the
//    submit claim and commit.
// 2. Insert only if every rule holds (this statement's snapshot is taken
//    after the lock wait, so it sees every committed claim, attempt, and
//    challenge). No ON CONFLICT: a duplicate round must fail loudly.
// 3. Why not, when nothing was inserted.
// $1 student, $2 reading, $3 note, $4 stale seconds.
export function challengeSendStatements(studentId: string, readingId: string, note: string): Statement[] {
  return [
    effortLockStatement(studentId, readingId),
    {
      text: `insert into challenges (student_id, reading_id, note, round)
select $1::uuid, $2::uuid, $3::text,
  (select coalesce(max(round), 0) + 1 from challenges where student_id = $1::uuid and reading_id = $2::uuid)
where ${ELIGIBLE}
and not ${PASSED}
and not ${BLOCKING}
and (${FAILS} >= ${TRIES_ALLOWED} or ${CHECKS} >= ${CHECKS_ALLOWED})
and not ${live(4)}
returning id`,
      params: [studentId, readingId, note, EFFORT_CLAIM_STALE_SECONDS],
    },
    challengeDiagnosisStatement(studentId, readingId),
  ];
}

// $1 student, $2 reading, $3 stale seconds. `blocking` is the status of
// the latest challenge that blocks a new one, if any.
export function challengeDiagnosisStatement(studentId: string, readingId: string): Statement {
  return {
    text: `select ${ELIGIBLE} as eligible, ${PASSED} as passed, ${FAILS}::int as fails, ${CHECKS}::int as checks,
  ${TRIES_ALLOWED} as tries_allowed, ${CHECKS_ALLOWED} as checks_allowed, ${live(3)} as live,
  (select status from challenges
    where student_id = $1::uuid and reading_id = $2::uuid and (status <> 'denied' or tries_allowed is null)
    order by round desc limit 1) as blocking`,
    params: [studentId, readingId, EFFORT_CLAIM_STALE_SECONDS],
  };
}

// Reads the send batch's results, most important reason first.
export function challengeOutcome(results: Record<string, unknown>[][]): ChallengeResult {
  if ((results[1]?.length ?? 0) > 0) return { status: "sent" };
  return challengeDiagnosis(results[2]?.[0]);
}

export function challengeDiagnosis(row: Record<string, unknown> | undefined): ChallengeResult {
  if (row?.eligible !== true) return { status: "not_found" };
  if (row.passed === true || row.blocking === "approved" || row.blocking === "closed") return { status: "already_passed" };
  if (row.blocking === "open") return { status: "already_sent" };
  if (row.blocking === "denied") return { status: "decided" };
  if (row.live === true) return { status: "busy" };
  const limits = limitsFromRow(row);
  const ready = Number(row.fails ?? 0) >= limits.tries || Number(row.checks ?? 0) >= limits.checks;
  // Ready but nothing was inserted: shouldn't happen under the lock.
  // Nothing was saved, so it's the generic "try again".
  if (ready) return { status: "not_found" };
  return { status: "not_ready" };
}

// `note` is the raw form value. Errors other than the challenge's own
// 23505 propagate, so the caller fails closed.
export async function sendChallengeWith(
  studentId: string,
  readingId: string,
  note: unknown,
  execute: StatementExecutor,
): Promise<ChallengeResult> {
  const valid = validateChallengeNote(note);
  if (!valid.ok) return { status: "invalid", error: valid.error };
  try {
    return challengeOutcome(await execute(challengeSendStatements(studentId, readingId, valid.note)));
  } catch (error) {
    if (isUniqueViolation(error, CHALLENGE_UNIQUE_CONSTRAINT)) return { status: "already_sent" };
    throw error;
  }
}

// Every outcome but "decided" (see ChallengeResult).
export function challengeMessage(result: Exclude<ChallengeResult, { status: "decided" }>): string {
  switch (result.status) {
    case "sent":
      return CHALLENGE_SENT_MESSAGE;
    case "already_sent":
      return CHALLENGE_ALREADY_SENT_MESSAGE;
    case "invalid":
      return result.error;
    case "not_ready":
      return CHALLENGE_NOT_READY_MESSAGE;
    case "already_passed":
      return CHALLENGE_PASSED_MESSAGE;
    case "busy":
      return CHALLENGE_BUSY_MESSAGE;
    case "not_found":
      return CHALLENGE_FAILED_MESSAGE;
  }
}
