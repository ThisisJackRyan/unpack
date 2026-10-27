// A teacher deletes one student and everything under them: their
// per-student question sets and claims, tries and answers, effort checks,
// challenges, and model-call counts. Pure statement and flow over an
// injected executor, so tests run it with fakes and
// scripts/check-abuse-protection.ts runs it against Postgres.
//
// ONE statement, so ONE transaction: the delete of the students row, with
// ownership (the class is this teacher's, and the student is in it)
// checked in the same statement, and every table under the student
// emptied by its ON DELETE CASCADE foreign key, all at once or not at all:
// questions.student_id, question_generations, student_question_calls,
// attempts (and answers through attempt_id and question_id),
// effort_checks, and challenges.
//
// Outcomes:
// - "deleted": this call deleted the student.
// - "already_gone": the class is this teacher's, but no such student is
//   in it (a second click after the first delete, or two tabs). A no-op
//   success: the teacher wanted them gone, and they are. We keep no
//   record of deleted ids, so an id that never existed in this class gets
//   the same answer; it changes nothing and reveals nothing beyond the
//   teacher's own class.
// - "not_found": the class isn't this teacher's (another teacher's, or no
//   such class). Nothing changes.
//
// The student's session is the session_token_hash on that row, so it ends
// with it: their cookie finds no student, and they're sent to the join
// form. Neon's restore history (point-in-time restore) still holds the
// deleted rows until its window passes (see docs/privacy.md).

import type { Statement, StatementExecutor } from "./link-rate-limit";

export const STUDENT_DELETE_FAILED_MESSAGE = "We couldn’t delete that. Please try again.";

export function studentDeletedMessage(name: string): string {
  return `Deleted ${name} and all of their work.`;
}

// $1 class, $2 teacher, $3 student.
export function deleteStudentStatement(classId: string, teacherId: string, studentId: string): Statement {
  return {
    text: `with owned as (
  select id from classes where id = $1::uuid and teacher_id = $2::uuid
),
deleted as (
  delete from students s
  using owned
  where s.id = $3::uuid and s.class_id = owned.id
  returning s.id
)
select (select count(*) from owned)::int as owned, (select count(*) from deleted)::int as deleted`,
    params: [classId, teacherId, studentId],
  };
}

export type DeleteStudentResult = { status: "deleted" } | { status: "already_gone" } | { status: "not_found" };

export async function deleteStudentWith(
  classId: string,
  teacherId: string,
  studentId: string,
  execute: StatementExecutor,
): Promise<DeleteStudentResult> {
  const [rows = []] = await execute([deleteStudentStatement(classId, teacherId, studentId)]);
  const row = rows[0];
  if (Number(row?.deleted ?? 0) > 0) return { status: "deleted" };
  return Number(row?.owned ?? 0) > 0 ? { status: "already_gone" } : { status: "not_found" };
}
