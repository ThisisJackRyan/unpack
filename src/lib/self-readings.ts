import "server-only";
import { randomUUID } from "node:crypto";
import { getEffortCheckModel, getQuestionModel, isQuestionWritingConfigured } from "./ai/client";
import { effortErrorLogFields } from "./ai/effort-check";
import { logModelError } from "./ai/errors";
import { isUuid } from "./classes";
import type { GradeLevel } from "./grade-levels";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import type { ReadingProgress } from "./reading-progress";
import {
  postgresSelfAttemptStore,
  selfEffortChecker,
  selfProgress,
  selfProgressStatements,
} from "./self-answers-core";
import {
  allowanceFor,
  allowanceFromRow,
  allowanceStatement,
  createOutcome,
  createSelfReadingStatements,
  selfLearnerPlan,
  type AllowanceState,
  type CreateOutcome,
  type ReadingAllowance,
  type SelfReadingDraft,
} from "./self-allowance";
import { historyItems, historyStatement, parseSelfResult, type HistoryItem, type SelfReadingResult } from "./self-history";
import {
  getOrCreateSelfQuestionsWith,
  postgresSelfQuestionStore,
  selfQuestionWriter,
  type SelfQuestionWriter,
  type SelfQuestionsResult,
} from "./self-questions-core";
import { submitAnswersWith, type EffortChecker, type SubmitResult } from "./submit-answers-core";
import { elapsedMs, monotonicNow, questionsGenerateReporter, type Clock } from "./timing-log";
import type { AnswerEntry } from "./validate-answers";

// Server-only: the self-learner flow against Postgres. Every function takes
// the signed-in account's id (from requireSelfLearner) and scopes every
// statement to it: only self_* rows, never classes, readings, or students.
// Another account's reading is not_found.

export function currentAllowance(): ReadingAllowance {
  return allowanceFor(selfLearnerPlan());
}

export async function getAllowance(
  accountId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<AllowanceState> {
  const allowance = currentAllowance();
  const [rows = []] = await execute([allowanceStatement(accountId, allowance)]);
  return allowanceFromRow(rows[0], allowance);
}

// Inserts the reading if the account is a self-learner under its allowance
// (see self-allowance.ts for the race handling).
export async function createSelfReading(
  accountId: string,
  draft: SelfReadingDraft,
  execute: StatementExecutor = neonExecutor,
): Promise<CreateOutcome> {
  const allowance = currentAllowance();
  return createOutcome(await execute(createSelfReadingStatements(accountId, draft, allowance)), allowance);
}

export type SelfReadingView = {
  id: string;
  title: string;
  sourceUrl: string | null;
  bodyText: string;
  gradeLevel: GradeLevel;
  questionCount: number;
  status: SelfReadingResult;
  createdAt: Date;
};

export async function getSelfReading(
  accountId: string,
  readingId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<SelfReadingView | undefined> {
  if (!isUuid(readingId)) return undefined;
  const [rows = []] = await execute([
    {
      text: `select id, title, source_url, body_text, grade_level, question_count, status, created_at
from self_readings where id = $2::uuid and account_id = $1::uuid`,
      params: [accountId, readingId],
    },
  ]);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: String(row.id),
    title: String(row.title),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    bodyText: String(row.body_text),
    gradeLevel: row.grade_level as GradeLevel,
    questionCount: Number(row.question_count),
    status: parseSelfResult(row.status),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

// The real writer: the configured model, at the reading's level and count,
// with the solo prompt. Each write logs questions.generate (timing-log.ts).
function modelWriter(readingId: string): SelfQuestionWriter {
  return selfQuestionWriter(getQuestionModel, questionsGenerateReporter({ readingId, mode: "self" }));
}

export type SelfOptions = {
  // For scripts/check-self-learner.ts: fakes, so the check never calls
  // the model. The app passes nothing.
  write?: SelfQuestionWriter;
  check?: EffortChecker;
  execute?: StatementExecutor;
  // The answer action's pre-check deadline (see answer-check-guard.ts).
  preCheck?: AbortSignal;
  // Called when this request starts writing the set (for the
  // questions.page_ready log's "generated").
  onWrite?: () => void;
};

export async function getOrCreateSelfQuestions(
  accountId: string,
  readingId: string,
  options: SelfOptions = {},
): Promise<SelfQuestionsResult> {
  if (!isUuid(readingId)) return { status: "not_found" };
  const write = options.write ?? modelWriter(readingId);
  return getOrCreateSelfQuestionsWith(accountId, readingId, {
    store: postgresSelfQuestionStore(options.execute ?? neonExecutor),
    write: (context) => {
      options.onWrite?.();
      return write(context);
    },
    newToken: randomUUID,
    configured: options.write ? true : isQuestionWritingConfigured(),
    onErrorFields: (fields) => logModelError("getOrCreateSelfQuestions: write failed", { ...fields, readingId }),
  });
}

// getOrCreateSelfQuestions for the reading page, with what the
// questions.page_ready log needs: whether this request wrote the set, and
// how long resolving the questions took.
export async function getSelfQuestionsTimed(
  accountId: string,
  readingId: string,
  now: Clock = monotonicNow,
): Promise<{ result: SelfQuestionsResult; generated: boolean; questionsMs: number }> {
  const started = now();
  let generated = false;
  const result = await getOrCreateSelfQuestions(accountId, readingId, { onWrite: () => (generated = true) });
  return { result, generated, questionsMs: elapsedMs(started, now) };
}

const modelChecker = selfEffortChecker(getEffortCheckModel);

export async function submitSelfAnswers(
  accountId: string,
  readingId: string,
  entries: AnswerEntry[],
  options: SelfOptions = {},
): Promise<SubmitResult> {
  if (!isUuid(readingId)) return { status: "not_found" };
  return submitAnswersWith(accountId, readingId, entries, {
    store: postgresSelfAttemptStore(options.execute ?? neonExecutor),
    check: options.check ?? modelChecker,
    newId: randomUUID,
    preCheck: options.preCheck,
    onError: (error) =>
      logModelError("submitSelfAnswers: effort check failed", { ...effortErrorLogFields(error), readingId }),
  });
}

export async function loadSelfProgress(
  accountId: string,
  readingId: string,
  execute: StatementExecutor = neonExecutor,
): Promise<ReadingProgress> {
  return selfProgress(await execute(selfProgressStatements(accountId, readingId)));
}

export async function listSelfHistory(
  accountId: string,
  timeZone: string,
  execute: StatementExecutor = neonExecutor,
): Promise<HistoryItem[]> {
  const [rows = []] = await execute([historyStatement(accountId)]);
  return historyItems(rows, timeZone);
}
