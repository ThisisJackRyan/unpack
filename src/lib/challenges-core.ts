// A student's challenge (a review request to their teacher) after their
// last failed try. Pure statements and flow over an injected executor, so
// tests run it with fakes; the server-only runner is challenges.ts.
//
// One per student per reading. The insert is conditional (the reading is
// published and in the student's class, MAX_TRIES failed attempts, no
// pass), and the unique (student_id, reading_id) constraint is what makes
// 20 parallel sends save exactly one: the rest wait on the index, then fail
// with 23505, which means "already sent". Only the note is stored, with
// the ids and status: minimal data.

import type { Statement, StatementExecutor } from "./link-rate-limit";
import { isUniqueViolation } from "./pg-errors";
import { MAX_TRIES, validateChallengeNote } from "./validate-answers";

export const CHALLENGE_UNIQUE_CONSTRAINT = "challenges_student_id_reading_id_unique";

export const CHALLENGE_SENT_MESSAGE = "Sent! Your teacher will take a look.";
export const CHALLENGE_ALREADY_SENT_MESSAGE = "You already sent a note. Your teacher will take a look.";
export const CHALLENGE_NOT_READY_MESSAGE = `You can send a note after ${MAX_TRIES} tries.`;
export const CHALLENGE_PASSED_MESSAGE = "You already passed this one. Nice work!";
export const CHALLENGE_FAILED_MESSAGE = "We couldn’t send your note. Try again.";

export type ChallengeResult =
  | { status: "sent" }
  | { status: "already_sent" }
  | { status: "invalid"; error: string }
  // Fewer than MAX_TRIES failed tries.
  | { status: "not_ready" }
  | { status: "already_passed" }
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

// $1 student, $2 reading, $3 note, $4 MAX_TRIES. No ON CONFLICT: a second
// challenge must fail loudly with 23505.
export function challengeInsertStatement(studentId: string, readingId: string, note: string): Statement {
  return {
    text: `insert into challenges (student_id, reading_id, note)
select $1::uuid, $2::uuid, $3::text
where ${ELIGIBLE}
and ${FAILS} >= $4::int
and not ${PASSED}
returning id`,
    params: [studentId, readingId, note, MAX_TRIES],
  };
}

// Why nothing was inserted. Run on its own: a 23505 aborts the insert's
// transaction.
export function challengeDiagnosisStatement(studentId: string, readingId: string): Statement {
  return {
    text: `select ${ELIGIBLE} as eligible, ${PASSED} as passed, ${FAILS}::int as fails,
  exists (select 1 from challenges where student_id = $1::uuid and reading_id = $2::uuid) as sent`,
    params: [studentId, readingId],
  };
}

export function challengeDiagnosis(row: Record<string, unknown> | undefined): ChallengeResult {
  if (row?.eligible !== true) return { status: "not_found" };
  if (row.sent === true) return { status: "already_sent" };
  if (row.passed === true) return { status: "already_passed" };
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
  let rows: Record<string, unknown>[];
  try {
    [rows = []] = await execute([challengeInsertStatement(studentId, readingId, valid.note)]);
  } catch (error) {
    if (isUniqueViolation(error, CHALLENGE_UNIQUE_CONSTRAINT)) return { status: "already_sent" };
    throw error;
  }
  if (rows.length > 0) return { status: "sent" };
  const [diagnosis = []] = await execute([challengeDiagnosisStatement(studentId, readingId)]);
  return challengeDiagnosis(diagnosis[0]);
}

export function challengeMessage(result: ChallengeResult): string {
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
    case "not_found":
      return CHALLENGE_FAILED_MESSAGE;
  }
}
