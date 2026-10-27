import "server-only";
import { neonExecutor } from "./neon-executor";
import { checkQuestionGenerationLimit } from "./question-rate-limit";

// Server-only: runs the question generation rate limit against Postgres,
// as one READ COMMITTED transaction (see questionGenerationStatements).
export function recordQuestionGeneration(teacherId: string): Promise<boolean> {
  return checkQuestionGenerationLimit(teacherId, neonExecutor);
}
