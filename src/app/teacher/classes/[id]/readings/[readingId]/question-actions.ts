"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getQuestionModel, isQuestionWritingConfigured } from "@/lib/ai/client";
import { logModelError } from "@/lib/ai/errors";
import {
  QUESTION_ERROR_MESSAGES,
  questionErrorKind,
  questionErrorLogFields,
  writeQuestionSet,
  writeReplacementQuestion,
} from "@/lib/ai/questions";
import { guardCreate, withDeadline } from "@/lib/create-guard";
import { effectiveGradeLevel } from "@/lib/grade-levels";
import { questionGenerationRetryAt, recordQuestionGeneration } from "@/lib/question-generation-attempts";
import { QUESTION_GENERATION_LIMITED_MESSAGE } from "@/lib/question-rate-limit";
import { withRetryAt } from "@/lib/local-time";
import { requestRetryClock } from "@/lib/request-time-zone";
import { getReadingForTeacher } from "@/lib/readings";
import { safeErrorFields, type SafeErrorFields } from "@/lib/safe-error-fields";
import {
  checkPublish,
  LAST_QUESTION_MESSAGE,
  planDelete,
  PUBLISHED_LOCKED_MESSAGE,
  QUESTIONS_EXIST_MESSAGE,
  READING_CHANGED_MESSAGE,
  type ReadingRef,
} from "@/lib/shared-questions";
import {
  bodyMd5,
  deleteSharedQuestion,
  listSharedQuestions,
  publishReading,
  saveQuestionSet,
  updateSharedQuestion,
} from "@/lib/shared-questions-db";
import { getOrCreateTeacher } from "@/lib/teacher";
import { questionsGenerateReporter } from "@/lib/timing-log";
import {
  isQuestionIntent,
  QUESTION_MAX_LENGTH,
  type QuestionActionState,
  type QuestionIntent,
} from "./question-state";

const NOT_FOUND_MESSAGE = "We couldn’t find this reading.";
const SAVE_FAILED_MESSAGE = "We couldn’t save that. Please try again.";

// Safe fields only (safe-error-fields.ts): a query error's message can
// echo the row, including the reading text or a question.
function logDbError(where: string, fields: SafeErrorFields, readingId: string) {
  console.error(where, { ...fields, readingId });
}

// One action for every button on the questions panel (Publish among
// them), so the panel has one pending state and every other control is
// disabled while anything runs. Never throws, except Next's redirects: the
// lookups before the first write (the teacher, the reading, its
// questions) give up at PRE_WRITE_DEADLINE_MS, and any failure is "We
// couldn’t save that" on the panel or its card (see create-guard.ts). The
// writes themselves (publish, save, delete, the question limit's record)
// are never cut.
export async function questionAction(
  classId: string,
  readingId: string,
  _prev: QuestionActionState,
  formData: FormData,
): Promise<QuestionActionState> {
  const intent = formData.get("intent");
  if (!isQuestionIntent(intent)) return { error: SAVE_FAILED_MESSAGE };
  const questionId = String(formData.get("questionId") ?? "") || undefined;
  const fail = (error: string): QuestionActionState => ({ intent, questionId, error });
  return guardCreate(
    (preWrite) => runQuestionAction(classId, readingId, intent, questionId, formData, preWrite),
    () => fail(SAVE_FAILED_MESSAGE),
    {
      // getOrCreateTeacher's redirects are errors Next must handle.
      rethrow: unstable_rethrow,
      onError: (error) => logDbError(`questionAction: ${intent satisfies QuestionIntent} failed`, safeErrorFields(error), readingId),
    },
  );
}

async function runQuestionAction(
  classId: string,
  readingId: string,
  intent: QuestionIntent,
  questionId: string | undefined,
  formData: FormData,
  preWrite: AbortSignal,
): Promise<QuestionActionState> {
  const fail = (error: string): QuestionActionState => ({ intent, questionId, error });
  const teacher = await withDeadline(getOrCreateTeacher(), preWrite);
  const ref: ReadingRef = { classId, readingId, teacherId: teacher.id };

  const found = await withDeadline(getReadingForTeacher(classId, readingId, teacher.id), preWrite);
  if (!found) return fail(NOT_FOUND_MESSAGE);
  const { reading } = found;
  if (reading.status !== "draft") return fail(PUBLISHED_LOCKED_MESSAGE);

  const shared = reading.questionMode === "shared";
  // Shared-set intents need shared mode; the sample needs per-student.
  if (intent === "sample" ? shared : intent !== "publish" && !shared) {
    return fail(READING_CHANGED_MESSAGE);
  }

  const questions = shared ? await withDeadline(listSharedQuestions(reading.id), preWrite) : [];
  const target = questionId ? questions.find((q) => q.id === questionId) : undefined;
  const done = (status: string, extra: QuestionActionState = {}) => {
    revalidatePath(`/teacher/classes/${classId}/readings/${readingId}`);
    return { intent, questionId, ok: true, status, ...extra };
  };
  // A refused conditional write: say why, from a fresh read.
  const refused = async () => {
    const again = await getReadingForTeacher(classId, readingId, teacher.id);
    revalidatePath(`/teacher/classes/${classId}/readings/${readingId}`);
    return fail(
      again?.reading.status === "published"
        ? PUBLISHED_LOCKED_MESSAGE
        : READING_CHANGED_MESSAGE,
    );
  };

  switch (intent) {
    case "update": {
      if (!target) return fail(READING_CHANGED_MESSAGE);
      const prompt = String(formData.get("prompt") ?? "").trim();
      if (!prompt) return fail("Write a question, or delete this one.");
      if (prompt.length > QUESTION_MAX_LENGTH) {
        return fail(`Keep questions under ${QUESTION_MAX_LENGTH} characters.`);
      }
      if (!(await updateSharedQuestion(ref, target.id, prompt))) return refused();
      return done("Question saved.");
    }
    case "delete": {
      const plan = planDelete(questions, questionId ?? "", reading.questionCount);
      if (!plan.ok) return fail(plan.error);
      if (!(await deleteSharedQuestion(ref, questionId!))) {
        // The SQL refuses the last question too; say so if that's why.
        return questions.length <= 1 ? fail(LAST_QUESTION_MESSAGE) : refused();
      }
      return done("Question deleted.");
    }
    case "publish": {
      const check = checkPublish(reading.questionMode, reading.questionCount, questions.length);
      if (!check.ok) return fail(check.error);
      if (!(await publishReading(ref))) return refused();
      return done("Published.");
    }
  }

  // The rest call the model.
  if (intent === "generate" && questions.length > 0) return fail(QUESTIONS_EXIST_MESSAGE);
  if (intent === "regenerate_one" && !target) return fail(READING_CHANGED_MESSAGE);
  // Checked before the rate limit, so missing AI Gateway credentials
  // cost nothing.
  if (!isQuestionWritingConfigured()) return fail(QUESTION_ERROR_MESSAGES.not_configured);

  // Counted before the call, whatever its outcome. Fails closed.
  let allowed: boolean;
  try {
    allowed = await recordQuestionGeneration(teacher.id);
  } catch (error) {
    logDbError("questionAction: recordQuestionGeneration failed", safeErrorFields(error), readingId);
    return fail(QUESTION_ERROR_MESSAGES.failed);
  }
  if (!allowed) {
    // A limit, not an error: an amber note with when the next one frees
    // up (a relative time if that can't be read).
    const retryAt = await questionGenerationRetryAt(teacher.id).catch(() => null);
    return { intent, questionId, limit: withRetryAt(QUESTION_GENERATION_LIMITED_MESSAGE, retryAt, await requestRetryClock()) };
  }

  const gradeLevel = effectiveGradeLevel(reading.gradeLevel, found.class.gradeLevel);
  const input = {
    bodyText: reading.bodyText,
    gradeLevel,
    count: reading.questionCount,
  };
  // Each write logs questions.generate (timing-log.ts).
  const write = { onReport: questionsGenerateReporter({ readingId: reading.id, mode: reading.questionMode, intent }) };
  let written: string[];
  try {
    const model = getQuestionModel();
    written =
      intent === "regenerate_one"
        ? [
            await writeReplacementQuestion(
              model,
              {
                ...input,
                position: target!.position,
                current: questions.map((q) => q.prompt),
              },
              write,
            ),
          ]
        : await writeQuestionSet(model, input, write);
  } catch (error) {
    logModelError("questionAction: write failed", {
      ...questionErrorLogFields(error),
      intent,
      readingId,
    });
    return fail(QUESTION_ERROR_MESSAGES[questionErrorKind(error)]);
  }

  if (intent === "sample") return done("Sample ready.", { sample: written });
  if (intent === "regenerate_one") {
    if (!(await updateSharedQuestion(ref, target!.id, written[0]))) return refused();
    return done("Question replaced.");
  }
  const fingerprint = {
    bodyMd5: bodyMd5(reading.bodyText),
    gradeLevel,
    questionCount: reading.questionCount,
  };
  const mode = intent === "generate" ? "generate" : "replace";
  if (!(await saveQuestionSet(ref, fingerprint, written, mode))) return refused();
  return done("Questions written.");
}
