import "server-only";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import {
  progressStatements,
  readingListItems,
  readingListStatement,
  readingProgress,
  type ReadingProgress,
  type StudentReadingListItem,
} from "./reading-progress";

// Server-only: a student's attempts, challenge, and effort check count,
// for the reading page and the class home (see reading-progress.ts for how
// status and the page's stage are derived). Callers have already scoped
// the reading to the student's class.

export async function loadReadingProgress(
  studentId: string,
  readingId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<ReadingProgress> {
  return readingProgress(await execute(progressStatements(studentId, readingId)));
}

// The class's published readings, newest first, each with this student's
// status.
export async function listReadingsWithStatus(
  classId: string,
  studentId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<StudentReadingListItem[]> {
  const [rows = []] = await execute([readingListStatement(classId, studentId)]);
  return readingListItems(rows);
}
