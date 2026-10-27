import "server-only";
import { randomUUID } from "node:crypto";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { getQuestionModel, isQuestionWritingConfigured } from "./ai/client";
import { writeQuestionSet } from "./ai/questions";
import { logModelError } from "./ai/errors";
import { isUuid } from "./classes";
import type { GradeLevel } from "./grade-levels";
import {
  claimOutcome,
  claimStatements,
  commitStatements,
  getOrCreateStudentQuestionsWith,
  releaseStatement,
  studentContextStatement,
  studentQuestionsStatement,
  takeOverOutcome,
  takeOverStatements,
  type StudentQuestionStore,
  type StudentQuestionWriter,
  type StudentQuestionsResult,
} from "./student-questions-core";

// Server-only: a student's per-student question set, generated on first
// open and cached (see student-questions-core.ts for the claim protocol).
// Called by the student reading page (src/lib/student-readings.ts).

export type {
  StudentQuestion,
  StudentQuestionsResult,
} from "./student-questions-core";
export {
  STUDENT_GENERATION_THROTTLED_MESSAGE,
  STUDENT_SETS_LIMITED_MESSAGE,
  STUDENT_SETS_PER_READING_LIMIT,
} from "./student-questions-core";

export function postgresStudentQuestionStore(
  execute: StatementExecutor = neonExecutor,
): StudentQuestionStore {
  const one = async (statement: Statement) => (await execute([statement]))[0] ?? [];
  return {
    async loadContext(readingId, studentId) {
      const [row] = await one(studentContextStatement(readingId, studentId));
      if (!row) return { status: "not_found" };
      if (row.in_class !== true) return { status: "not_allowed" };
      return {
        status: "ok",
        context: {
          bodyText: String(row.body_text),
          gradeLevel: row.grade_level as GradeLevel,
          questionCount: Number(row.question_count),
        },
      };
    },
    async readQuestions(readingId, studentId) {
      const rows = await one(studentQuestionsStatement(readingId, studentId));
      return rows.map((r) => ({
        id: String(r.id),
        position: Number(r.position),
        prompt: String(r.prompt),
      }));
    },
    async claim(readingId, studentId, token, limit) {
      return claimOutcome(await execute(claimStatements(readingId, studentId, token, limit)), limit);
    },
    async takeOverStale(readingId, studentId, token, staleSeconds) {
      return takeOverOutcome(await execute(takeOverStatements(readingId, studentId, token, staleSeconds)));
    },
    async release(readingId, studentId, token, refundCall) {
      await one(releaseStatement(readingId, studentId, token, refundCall));
    },
    async commit(readingId, studentId, token, prompts) {
      const results = await execute(commitStatements(readingId, studentId, token, prompts));
      return (results[1]?.length ?? 0) === prompts.length;
    },
  };
}

// The real writer: the configured model, at the reading's grade and count.
// Reports each reply the model sends, so the throttle counts a write only
// if the model answered (see failureCounts). getQuestionModel throws
// before any call without AI Gateway credentials, so that never counts.
const modelWriter: StudentQuestionWriter = (context, hooks) => {
  const model = getQuestionModel();
  return writeQuestionSet(
    {
      model: model.model,
      create: async (params, options) => {
        const reply = await model.create(params, options);
        hooks.onModelResponse();
        return reply;
      },
    },
    { bodyText: context.bodyText, gradeLevel: context.gradeLevel, count: context.questionCount },
  );
};

export type GetStudentQuestionsOptions = {
  // For scripts/check-student-questions.ts: a mock model, so the check
  // never calls the model. The app passes nothing.
  write?: StudentQuestionWriter;
  store?: StudentQuestionStore;
};

// Returns the student's cached set, or writes and caches it once. See
// StudentQuestionsResult for every outcome: "not_found" for anything but a
// published per-student reading (or a malformed id), "not_allowed" for a
// student outside its class, "limit_reached" past the per-reading cap.
// Student generations don't count toward the teacher's rate limit (see
// question-rate-limit.ts).
export async function getOrCreateStudentQuestions(
  readingId: string,
  studentId: string,
  options: GetStudentQuestionsOptions = {},
): Promise<StudentQuestionsResult> {
  if (!isUuid(readingId) || !isUuid(studentId)) return { status: "not_found" };
  return getOrCreateStudentQuestionsWith(readingId, studentId, {
    store: options.store ?? postgresStudentQuestionStore(),
    write: options.write ?? modelWriter,
    newToken: randomUUID,
    // An injected writer (the DB checks) needs no key.
    configured: options.write ? true : isQuestionWritingConfigured(),
    onError: (fields) =>
      logModelError("getOrCreateStudentQuestions: write failed", { ...fields, readingId }),
  });
}
