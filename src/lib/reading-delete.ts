// A teacher deletes one reading and everything under it. Pure statement
// and flow over an injected executor, so tests run it with fakes and
// scripts/check-teacher-gaps.ts runs it against Postgres. The same shape
// as the student delete (student-delete.ts).
//
// ONE statement, so ONE transaction: the delete of the readings row, with
// ownership (the class is this teacher's, and the reading is in it)
// checked in the same statement, and every table under the reading
// emptied by its ON DELETE CASCADE foreign key, all at once or not at all:
// questions (shared and per-student, and answers through question_id),
// question_generations, student_question_calls, attempts (and answers
// through attempt_id), effort_checks, challenges, and reading_cap_raises.
// Students stay: they belong to the class, not the reading.
//
// Outcomes:
// - "deleted": this call deleted the reading.
// - "already_gone": the class is this teacher's, but no such reading is
//   in it (a second click, or two tabs). A no-op success, like the
//   student delete: we keep no record of deleted ids, so an id that never
//   existed in this class gets the same answer and changes nothing.
// - "not_found": the class isn't this teacher's. Nothing changes.
//
// Neon's restore history still holds the deleted rows until its window
// passes (see docs/privacy.md).

import type { Statement, StatementExecutor } from "./link-rate-limit";

export const READING_DELETE_FAILED_MESSAGE = "We couldn’t delete that reading. Please try again.";

// Shown on the class page after the redirect.
export const READING_DELETED_MESSAGE = "Reading deleted, with its questions and every student’s answers and tries.";

// The class page's query flag for READING_DELETED_MESSAGE.
export const READING_DELETED_FLAG = "reading-deleted";

// $1 class, $2 teacher, $3 reading.
export function deleteReadingStatement(classId: string, teacherId: string, readingId: string): Statement {
  return {
    text: `with owned as (
  select id from classes where id = $1::uuid and teacher_id = $2::uuid
),
deleted as (
  delete from readings r
  using owned
  where r.id = $3::uuid and r.class_id = owned.id
  returning r.id
)
select (select count(*) from owned)::int as owned, (select count(*) from deleted)::int as deleted`,
    params: [classId, teacherId, readingId],
  };
}

export type DeleteReadingResult = { status: "deleted" } | { status: "already_gone" } | { status: "not_found" };

export async function deleteReadingWith(
  classId: string,
  teacherId: string,
  readingId: string,
  execute: StatementExecutor,
): Promise<DeleteReadingResult> {
  const [rows = []] = await execute([deleteReadingStatement(classId, teacherId, readingId)]);
  const row = rows[0];
  if (Number(row?.deleted ?? 0) > 0) return { status: "deleted" };
  return Number(row?.owned ?? 0) > 0 ? { status: "already_gone" } : { status: "not_found" };
}
