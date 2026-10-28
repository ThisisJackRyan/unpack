import "server-only";
import { isUuid } from "./classes";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { teacherAnswers, teacherAnswersStatements, type TeacherAnswers, type TeacherAnswersFilter } from "./teacher-answers";

// Server-only: a student's answers for their teacher (see
// teacher-answers.ts). `teacherId` must come from the server session
// (getOrCreateTeacher), never from the request; the class, reading, and
// student ids may come from the URL, and the owner-scoped SQL ignores any
// that aren't this teacher's. A malformed id matches nothing.
// `execute` is for scripts/check-teacher-queue.ts; the app passes nothing.
export async function loadTeacherAnswers(
  classId: string,
  teacherId: string,
  filter: TeacherAnswersFilter,
  execute: StatementExecutor = neonExecutor,
): Promise<TeacherAnswers> {
  const ids = [classId, teacherId, filter.readingId, filter.studentId].filter((id): id is string => typeof id === "string");
  if (!ids.every(isUuid)) return {};
  return teacherAnswers(await execute(teacherAnswersStatements(classId, teacherId, filter)));
}
