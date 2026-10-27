"use server";

import { revalidatePath } from "next/cache";
import { getQuestionModel, isQuestionWritingConfigured } from "@/lib/ai/client";
import {
  QUESTION_ERROR_MESSAGES,
  questionErrorKind,
  questionErrorLogFields,
  writeQuestionSet,
  writeReplacementQuestion,
} from "@/lib/ai/questions";
import { effectiveGradeLevel } from "@/lib/grade-levels";
import { recordQuestionGeneration } from "@/lib/question-generation-attempts";
import { QUESTION_GENERATION_LIMITED_MESSAGE } from "@/lib/question-rate-limit";
import { getReadingForTeacher } from "@/lib/readings";
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
import {
  isQuestionIntent,
  QUESTION_MAX_LENGTH,
  type QuestionActionState,
  type QuestionIntent,
} from "./question-state";

const NOT_FOUND_MESSAGE = "We couldn’t find this reading.";
const SAVE_FAILED_MESSAGE = "We couldn’t save that. Please try again.";

// Name, code, and message only: a Postgres error's detail can echo the
// row, including the reading text or a question.
function logDbError(where: string, error: unknown, readingId: string) {
  const { name, code, message } = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  console.error(where, { name, code, message, readingId });
}

// One action for every button on the questions panel, so the panel has one
// pending state and every other control is disabled while anything runs.
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

  const teacher = await getOrCreateTeacher();
  const ref: ReadingRef = { classId, readingId, teacherId: teacher.id };

  try {
    const found = await getReadingForTeacher(classId, readingId, teacher.id);
    if (!found) return fail(NOT_FOUND_MESSAGE);
    const { reading } = found;
    if (reading.status !== "draft") return fail(PUBLISHED_LOCKED_MESSAGE);

    const shared = reading.questionMode === "shared";
    // Shared-set intents need shared mode; the sample needs per-student.
    if (intent === "sample" ? shared : intent !== "publish" && !shared) {
      return fail(READING_CHANGED_MESSAGE);
    }

    const questions = shared ? await listSharedQuestions(reading.id) : [];
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
      logDbError("questionAction: recordQuestionGeneration failed", error, readingId);
      return fail(QUESTION_ERROR_MESSAGES.failed);
    }
    if (!allowed) return fail(QUESTION_GENERATION_LIMITED_MESSAGE);

    const gradeLevel = effectiveGradeLevel(reading.gradeLevel, found.class.gradeLevel);
    const input = {
      bodyText: reading.bodyText,
      gradeLevel,
      count: reading.questionCount,
    };
    let written: string[];
    try {
      const model = getQuestionModel();
      written =
        intent === "regenerate_one"
          ? [
              await writeReplacementQuestion(model, {
                ...input,
                position: target!.position,
                current: questions.map((q) => q.prompt),
              }),
            ]
          : await writeQuestionSet(model, input);
    } catch (error) {
      console.error("questionAction: write failed", {
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
  } catch (error) {
    logDbError(`questionAction: ${intent satisfies QuestionIntent} failed`, error, readingId);
    return fail(SAVE_FAILED_MESSAGE);
  }
}
