// A student's limits on one reading, and the advisory lock that guards
// them. Shared by the submit claim and commit (submit-answers-core.ts),
// the challenge insert (challenges-core.ts), the teacher's decision
// (challenge-queue-core.ts), and the status queries (reading-progress.ts,
// class-status.ts). Pure: SQL text and numbers only.
//
// The limits start at MAX_TRIES tries and EFFORT_CHECK_LIMIT checks. A
// teacher who denies a challenge with "Give one more try" stores new
// limits on that challenge row (tries_allowed, checks_allowed): tries used
// + 1 and checks used + EXTRA_TRY_CHECKS, so the student has exactly 1 try
// left whatever they had before (a student who reached the check limit
// with 2 tries unused gets 1, not 3). The latest round with a grant wins.
// Nothing is deleted or reset: every attempt, answer, and effort check
// stays, and only the limits move.

import type { Statement } from "./link-rate-limit";
import { EFFORT_CHECK_LIMIT, MAX_TRIES } from "./validate-answers";

// Checks granted with one more try: 1 for the try, plus 1 spare in case
// the model fails (a failed check doesn't use the try). If both fail, the
// student is at the check limit again and can send a new note.
export const EXTRA_TRY_CHECKS = 2;

export type Limits = { tries: number; checks: number };

export const DEFAULT_LIMITS: Limits = { tries: MAX_TRIES, checks: EFFORT_CHECK_LIMIT };

// Advisory lock namespace for (student, reading) (join-rate-limit.ts uses
// 1 and 2). Every write that counts or changes a student's attempts,
// checks, or challenges on a reading takes it first.
export const EFFORT_LOCK_SPACE = 3;

// The lock key is "<student id>:<reading id>", lowercase, so it matches
// the key built in SQL from uuid::text (always lowercase) by
// challengeLockSql. A reading id from the URL may be uppercase.
export function effortLockKey(studentId: string, readingId: string): string {
  return `${studentId}:${readingId}`.toLowerCase();
}

export function effortLockStatement(studentId: string, readingId: string): Statement {
  return {
    text: "select pg_advisory_xact_lock($1::int, hashtext($2::text))",
    params: [EFFORT_LOCK_SPACE, effortLockKey(studentId, readingId)],
  };
}

// The same lock, keyed from a row's student_id and reading_id columns.
export function effortLockSql(studentCol: string, readingCol: string): string {
  return `pg_advisory_xact_lock(${EFFORT_LOCK_SPACE}, hashtext(${studentCol}::text || ':' || ${readingCol}::text))`;
}

// The latest grant's value for `column`, else `fallback`. `student` and
// `reading` are SQL expressions ($1::uuid, s.id, ...).
function grantSql(column: "tries_allowed" | "checks_allowed", fallback: number, student: string, reading: string): string {
  return `coalesce((select g.${column} from challenges g
    where g.student_id = ${student} and g.reading_id = ${reading} and g.${column} is not null
    order by g.round desc limit 1), ${fallback})`;
}

export function triesAllowedSql(student: string, reading: string): string {
  return grantSql("tries_allowed", MAX_TRIES, student, reading);
}

export function checksAllowedSql(student: string, reading: string): string {
  return grantSql("checks_allowed", EFFORT_CHECK_LIMIT, student, reading);
}

// The student's latest challenge (highest round), for a lateral join:
// status, and whether it was denied with one more try.
export function latestChallengeSql(student: string, reading: string): string {
  return `(select lc.status, lc.tries_allowed is not null as extra_try from challenges lc
    where lc.student_id = ${student} and lc.reading_id = ${reading}
    order by lc.round desc limit 1)`;
}

export function limitsFromRow(row: Record<string, unknown> | undefined): Limits {
  const tries = Number(row?.tries_allowed);
  const checks = Number(row?.checks_allowed);
  return {
    tries: Number.isInteger(tries) && tries > 0 ? tries : MAX_TRIES,
    checks: Number.isInteger(checks) && checks > 0 ? checks : EFFORT_CHECK_LIMIT,
  };
}
