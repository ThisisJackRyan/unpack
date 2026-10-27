// "Let them try again": a teacher resets one student's "Try again" budget
// for one reading (see student-questions-core.ts), after the student used
// every model call for it without getting questions. Pure statement and
// flow over an injected executor, so tests run it with fakes and
// scripts/check-abuse-protection.ts runs it against Postgres.
//
// ONE statement, so ONE transaction:
// - `owned` finds the student only if the class is this teacher's, the
//   student is in it, and the reading is in it too. Another teacher, a
//   student or reading from another class, or ids that don't exist match
//   nothing: "not_found", and nothing changes.
// - `cleared` deletes that student's student_question_calls rows for that
//   reading, so the next open gets the full budget again (3 per 10
//   minutes, 6 in all). It leaves alone the row of a call that is running
//   right now (its claim is still pending, stamped with the same time), so
//   a reset during a call can't let a burst past the limit.
// A second click finds the student and nothing left to clear: "reset"
// again, a no-op success. Questions, tries, and answers aren't touched.

import type { Statement, StatementExecutor } from "./link-rate-limit";

export const RESET_TRIES_FAILED_MESSAGE = "We couldn’t do that. Please try again.";

export function resetTriesMessage(name: string): string {
  return `Done. ${name} can try again now.`;
}

// $1 class, $2 teacher, $3 student, $4 reading.
export function resetStudentQuestionCallsStatement(
  classId: string,
  teacherId: string,
  studentId: string,
  readingId: string,
): Statement {
  return {
    text: `with owned as (
  select s.id from students s
  join classes c on c.id = s.class_id
  join readings r on r.class_id = c.id
  where c.id = $1::uuid and c.teacher_id = $2::uuid
    and s.id = $3::uuid and r.id = $4::uuid
),
cleared as (
  delete from student_question_calls q
  using owned
  where q.student_id = owned.id and q.reading_id = $4::uuid
    and not exists (
      select 1 from question_generations g
      where g.reading_id = q.reading_id and g.student_id = q.student_id
        and g.status = 'pending' and g.claimed_at = q.created_at
    )
  returning q.id
)
select (select count(*) from owned)::int as owned, (select count(*) from cleared)::int as cleared`,
    params: [classId, teacherId, studentId, readingId],
  };
}

export type ResetStudentTriesResult = { status: "reset"; cleared: number } | { status: "not_found" };

export async function resetStudentQuestionCallsWith(
  classId: string,
  teacherId: string,
  studentId: string,
  readingId: string,
  execute: StatementExecutor,
): Promise<ResetStudentTriesResult> {
  const [rows = []] = await execute([resetStudentQuestionCallsStatement(classId, teacherId, studentId, readingId)]);
  const row = rows[0];
  if (Number(row?.owned ?? 0) === 0) return { status: "not_found" };
  return { status: "reset", cleared: Number(row?.cleared ?? 0) };
}
