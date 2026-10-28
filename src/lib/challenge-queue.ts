import "server-only";
import {
  decideChallengeWith,
  noNoteItems,
  noNoteStatement,
  openCountStatement,
  queueCount,
  queueItems,
  queueStatements,
  teacherQueue,
  type DecideInput,
  type DecideResult,
  type QueueEntry,
  type QueueItem,
} from "./challenge-queue-core";
import { isUuid } from "./classes";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";

// Server-only: the teacher's challenge queue and decisions (see
// challenge-queue-core.ts for why a decision is race-safe). Every query
// and the decision itself are scoped to the class and its owning teacher.
// `execute` is for scripts/check-teacher-queue.ts; the app passes nothing.

export type { DecideResult, NoNoteItem, QueueEntry, QueueItem } from "./challenge-queue-core";

// What the challenges page lists: the open challenges and the students
// out of tries with no note yet, oldest first (see teacherQueue).
export async function loadTeacherQueue(
  classId: string,
  teacherId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<QueueEntry[]> {
  if (!isUuid(classId)) return [];
  const [list = [], questions = [], noNote = []] = await execute([
    ...queueStatements(classId, teacherId),
    noNoteStatement(classId, teacherId),
  ]);
  return teacherQueue(queueItems([list, questions]), noNoteItems(noNote));
}

// The count on the class page: the same entries as loadTeacherQueue.
export async function countTeacherQueue(
  classId: string,
  teacherId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<number> {
  if (!isUuid(classId)) return 0;
  const [list = [], noNote = []] = await execute([
    queueStatements(classId, teacherId)[0],
    noNoteStatement(classId, teacherId),
  ]);
  return queueCount(queueItems([list, []]), noNoteItems(noNote));
}

// The open challenges alone.
export async function loadChallengeQueue(
  classId: string,
  teacherId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<QueueItem[]> {
  if (!isUuid(classId)) return [];
  return queueItems(await execute(queueStatements(classId, teacherId)));
}

export async function countOpenChallenges(
  classId: string,
  teacherId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<number> {
  if (!isUuid(classId)) return 0;
  const [rows = []] = await execute([openCountStatement(classId, teacherId)]);
  return Number(rows[0]?.open ?? 0);
}

export function decideChallenge(
  input: DecideInput,
  execute: StatementExecutor = neonExecutor,
): Promise<DecideResult> {
  if (!isUuid(input.challengeId) || !isUuid(input.classId)) return Promise.resolve({ status: "not_found" });
  return decideChallengeWith(input, execute);
}
