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
// effort_checks, and challenges. Another teacher's request, a student in
// another class, or one already deleted matches nothing: "not_found", and
// nothing changes.
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
    text: `delete from students s
using classes c
where s.id = $3::uuid and s.class_id = $1::uuid
  and c.id = s.class_id and c.teacher_id = $2::uuid
returning s.id`,
    params: [classId, teacherId, studentId],
  };
}

export type DeleteStudentResult = { status: "deleted" } | { status: "not_found" };

export async function deleteStudentWith(
  classId: string,
  teacherId: string,
  studentId: string,
  execute: StatementExecutor,
): Promise<DeleteStudentResult> {
  const [rows = []] = await execute([deleteStudentStatement(classId, teacherId, studentId)]);
  return rows.length > 0 ? { status: "deleted" } : { status: "not_found" };
}
