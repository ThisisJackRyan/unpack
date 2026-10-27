import "server-only";
import { neonExecutor } from "./neon-executor";
import { dateFromRow } from "./local-time";
import { checkQuestionGenerationLimit, questionGenerationRetryAtStatement } from "./question-rate-limit";

// Server-only: runs the question generation rate limit against Postgres,
// as one READ COMMITTED transaction (see questionGenerationStatements).
export function recordQuestionGeneration(teacherId: string): Promise<boolean> {
  return checkQuestionGenerationLimit(teacherId, neonExecutor);
}

// When the next generation frees up (after a refusal), or null.
export async function questionGenerationRetryAt(accountId: string): Promise<Date | null> {
  const [rows = []] = await neonExecutor([questionGenerationRetryAtStatement(accountId)]);
  return dateFromRow(rows[0]?.retry_at);
}
