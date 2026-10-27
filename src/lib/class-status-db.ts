import "server-only";
import { isUuid } from "./classes";
import { classStatus, classStatusStatements, type ClassStatus } from "./class-status";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";

// Server-only: the teacher's class view (see class-status.ts). Scoped to
// the class and its owning teacher in every query; another teacher's
// class comes back empty (the page has already 404ed it).

export async function loadClassStatus(
  classId: string,
  teacherId: string,
  // For scripts/check-teacher-queue.ts; the app passes nothing.
  execute: StatementExecutor = neonExecutor,
): Promise<ClassStatus> {
  if (!isUuid(classId)) return { readings: [], students: [], cells: {} };
  return classStatus(await execute(classStatusStatements(classId, teacherId)));
}
