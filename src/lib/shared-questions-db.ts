import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import {
  deleteQuestionStatements,
  insertedCount,
  publishStatements,
  updateQuestionStatements,
  writeSetStatements,
  type QuestionFingerprint,
  type ReadingRef,
  type SharedQuestion,
} from "./shared-questions";

// Server-only: runs the shared question statements (see shared-questions.ts
// for the lock and count rules). Each write returns false when it was
// refused (published, not the teacher's, or the reading changed).

export function bodyMd5(bodyText: string): string {
  return createHash("md5").update(bodyText, "utf8").digest("hex");
}

// The reading's shared set, in order. Callers check ownership first (the
// reading came from getReadingForTeacher).
export function listSharedQuestions(readingId: string): Promise<SharedQuestion[]> {
  return db
    .select({
      id: schema.questions.id,
      position: schema.questions.position,
      prompt: schema.questions.prompt,
    })
    .from(schema.questions)
    .where(
      and(
        eq(schema.questions.readingId, readingId),
        isNull(schema.questions.studentId),
      ),
    )
    .orderBy(asc(schema.questions.position));
}

export async function saveQuestionSet(
  ref: ReadingRef,
  fingerprint: QuestionFingerprint,
  prompts: string[],
  mode: "generate" | "replace",
  execute: StatementExecutor = neonExecutor,
): Promise<boolean> {
  const results = await execute(writeSetStatements(ref, fingerprint, prompts, mode));
  return insertedCount(results) === prompts.length;
}

export async function updateSharedQuestion(
  ref: ReadingRef,
  questionId: string,
  prompt: string,
  execute: StatementExecutor = neonExecutor,
): Promise<boolean> {
  const results = await execute(updateQuestionStatements(ref, questionId, prompt));
  return insertedCount(results) === 1;
}

export async function deleteSharedQuestion(
  ref: ReadingRef,
  questionId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<boolean> {
  const results = await execute(deleteQuestionStatements(ref, questionId));
  return (results[1]?.length ?? 0) === 1;
}

export async function publishReading(
  ref: ReadingRef,
  execute: StatementExecutor = neonExecutor,
): Promise<boolean> {
  const results = await execute(publishStatements(ref));
  return insertedCount(results) === 1;
}
