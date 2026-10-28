// "Give one more try" on the queue's "Out of tries, no note yet" row: the
// teacher grants the student one more try without waiting for a note.
// Pure statements and flow over an injected executor, so tests run it
// with fakes; the server-only runner is challenge-queue.ts.
//
// The same grant as "Deny, give one more try" (challenge-queue-core.ts):
// a challenge round, denied, resolved by this teacher, with tries allowed
// = tries used + 1 and checks allowed = checks used + EXTRA_TRY_CHECKS
// (grantedTriesSql, grantedChecksSql). Only the note is missing: the row's
// note is empty (the column is NOT NULL with no length check; a student's
// note is never empty, see validateChallengeNote), and only an open round
// shows its note, so this one never is. The round is the next one, like
// a student's note, so a later note is round + 1 and the latest round's
// grant wins (reading-limits.ts). Nothing else changes: no schema change,
// and the student's page and status read it as a denial with one more try.
//
// As ONE READ COMMITTED transaction:
// 1. The student's (student, reading) advisory lock, the one the submit
//    claim and commit, the note, and the decision take.
// 2. Insert only if every rule holds, in one statement: the class is this
//    teacher's, the student is in it, the reading is published in it; no
//    pass; no open, approved, closed, or plain denied round (the same
//    BLOCKING rule a note uses); every try or every check used (the
//    Waiting state); and no effort check running (it could save a try or
//    a pass, so the grant waits: "busy").
// 3. Why not, when nothing was inserted.
// So a double-click, a second tab, or a note sent at the same moment
// makes at most one change: after a grant the student has a try left, so
// a second grant is refused ("not_waiting") until that try is used too,
// exactly as a second "Deny, give one more try" needs a second note.

import type { Statement, StatementExecutor } from "./link-rate-limit";
import type { GrantInput, GrantResult } from "./challenge-queue-core";
import { BLOCKING_SQL, CHALLENGE_UNIQUE_CONSTRAINT, CHECKS_SQL, liveCheckSql, PASSED_SQL } from "./challenges-core";
import { isUniqueViolation } from "./pg-errors";
import {
  checksAllowedSql,
  effortLockStatement,
  EXTRA_TRY_CHECKS,
  grantedChecksSql,
  grantedTriesSql,
  triesAllowedSql,
} from "./reading-limits";
import { EFFORT_CLAIM_STALE_SECONDS } from "./submit-answers-core";

// $1 student, $2 reading, $3 teacher, $4 class.
const OWNED = `exists (
  select 1 from readings r
  join classes c on c.id = r.class_id
  join students s on s.class_id = c.id
  where r.id = $2::uuid and s.id = $1::uuid and r.status = 'published'
    and c.id = $4::uuid and c.teacher_id = $3::uuid
)`;
const TRIES = `(select count(*) from attempts where student_id = $1::uuid and reading_id = $2::uuid)`;
const OUT = `(${TRIES} >= ${triesAllowedSql("$1::uuid", "$2::uuid")} or ${CHECKS_SQL} >= ${checksAllowedSql("$1::uuid", "$2::uuid")})`;

// $1 student, $2 reading, $3 teacher, $4 class, $5 extra checks, $6 stale
// seconds.
export function grantStatements(input: GrantInput): Statement[] {
  return [
    effortLockStatement(input.studentId, input.readingId),
    {
      text: `insert into challenges (student_id, reading_id, note, round, status, resolved_at, resolved_by, tries_allowed, checks_allowed)
select $1::uuid, $2::uuid, '',
  (select coalesce(max(round), 0) + 1 from challenges where student_id = $1::uuid and reading_id = $2::uuid),
  'denied', now(), $3::uuid,
  ${grantedTriesSql("$1::uuid", "$2::uuid")},
  ${grantedChecksSql("$1::uuid", "$2::uuid", "$5::int")}
where ${OWNED}
and not ${PASSED_SQL}
and not ${BLOCKING_SQL}
and ${OUT}
and not ${liveCheckSql(6)}
returning tries_allowed, checks_allowed`,
      params: [input.studentId, input.readingId, input.teacherId, input.classId, EXTRA_TRY_CHECKS, EFFORT_CLAIM_STALE_SECONDS],
    },
    {
      // Why not. $1 student, $2 reading, $3 teacher, $4 class, $5 stale
      // seconds.
      text: `select ${OWNED} as owned, ${PASSED_SQL} or ${BLOCKING_SQL} or not ${OUT} as not_waiting, ${liveCheckSql(5)} as live`,
      params: [input.studentId, input.readingId, input.teacherId, input.classId, EFFORT_CLAIM_STALE_SECONDS],
    },
  ];
}

export function grantOutcome(results: Record<string, unknown>[][]): GrantResult {
  if ((results[1]?.length ?? 0) > 0) return { status: "granted" };
  const row = results[2]?.[0];
  if (row?.owned !== true) return { status: "not_found" };
  if (row.not_waiting === true) return { status: "not_waiting" };
  if (row.live === true) return { status: "busy" };
  // Waiting, nothing running, and nothing inserted: shouldn't happen
  // under the lock. Nothing was saved, so the list is refreshed.
  return { status: "not_waiting" };
}

// Errors other than a duplicate round propagate, so the caller fails
// closed. A duplicate round can't happen under the lock; if it did, a
// round was just saved for this student, so they aren't waiting.
export async function grantExtraTryWith(input: GrantInput, execute: StatementExecutor): Promise<GrantResult> {
  try {
    return grantOutcome(await execute(grantStatements(input)));
  } catch (error) {
    if (isUniqueViolation(error, CHALLENGE_UNIQUE_CONSTRAINT)) return { status: "not_waiting" };
    throw error;
  }
}
