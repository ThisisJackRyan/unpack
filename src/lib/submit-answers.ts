import "server-only";
import { randomUUID } from "node:crypto";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { getEffortCheckModel } from "./ai/client";
import { checkEffort, effortErrorLogFields } from "./ai/effort-check";
import { isUuid } from "./classes";
import {
  postgresAttemptStore,
  submitAnswersWith,
  type EffortChecker,
  type SubmitResult,
} from "./submit-answers-core";
import type { AnswerEntry } from "./validate-answers";

// Server-only: a student's answers, checked for effort and saved as one
// attempt (see submit-answers-core.ts for the claim protocol and why it's
// race-safe). Called by the reading page's server action.

export type { SubmitResult } from "./submit-answers-core";

// The real checker: the configured model, all answers in one call.
const modelChecker: EffortChecker = (input) => checkEffort(getEffortCheckModel(), input);

export type SubmitAnswersOptions = {
  // For scripts/check-student-answers.ts: a fake checker (no Anthropic
  // calls) and a throttled executor. The app passes nothing.
  check?: EffortChecker;
  execute?: StatementExecutor;
};

export async function submitAnswers(
  studentId: string,
  readingId: string,
  entries: AnswerEntry[],
  options: SubmitAnswersOptions = {},
): Promise<SubmitResult> {
  if (!isUuid(readingId) || !isUuid(studentId)) return { status: "not_found" };
  return submitAnswersWith(studentId, readingId, entries, {
    store: postgresAttemptStore(options.execute ?? neonExecutor),
    check: options.check ?? modelChecker,
    newId: randomUUID,
    onError: (error) =>
      console.error("submitAnswers: effort check failed", { ...effortErrorLogFields(error), readingId }),
  });
}
