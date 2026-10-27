import "server-only";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { sendChallengeWith, type ChallengeResult } from "./challenges-core";
import { isUuid } from "./classes";

// Server-only: sends a student's challenge note (see challenges-core.ts).

export type { ChallengeResult } from "./challenges-core";

export function sendChallenge(
  studentId: string,
  readingId: string,
  note: unknown,
  // For scripts/check-student-answers.ts; the app passes nothing.
  execute: StatementExecutor = neonExecutor,
): Promise<ChallengeResult> {
  if (!isUuid(readingId) || !isUuid(studentId)) return Promise.resolve({ status: "not_found" });
  return sendChallengeWith(studentId, readingId, note, execute);
}
