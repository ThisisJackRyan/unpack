"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { guardAnswerCheck, withDeadline } from "@/lib/answer-check-guard";
import { isQuestionWritingConfigured } from "@/lib/ai/client";
import { sendChallenge, type ChallengeResult } from "@/lib/challenges";
import { CHALLENGE_FAILED_MESSAGE, challengeMessage } from "@/lib/challenges-core";
import { getStudentSession } from "@/lib/student-auth";
import { submitAnswers } from "@/lib/submit-answers";
import { CHECK_FAILED_MESSAGE, refreshesPage, submitMessage } from "@/lib/submit-answers-core";
import { withRetryAt } from "@/lib/local-time";
import { requestRetryClock } from "@/lib/request-time-zone";
import { safeErrorFields, type SafeErrorFields } from "@/lib/safe-error-fields";
import { ANSWERS_FIX_MESSAGE, answerEntries } from "@/lib/validate-answers";
import { TIMED_OUT_STATE, type AnswerFormState, type ChallengeFormState } from "./form-state";

// Safe fields only (safe-error-fields.ts): a query error's message can
// echo the row, including a student's answer or name.
function logError(where: string, fields: SafeErrorFields, readingId: string) {
  console.error(where, { ...fields, readingId });
}

// The page and the class home both show the new state.
function refresh(readingId: string) {
  revalidatePath(`/c/r/${readingId}`);
  revalidatePath("/c");
}

// Checks every answer at once (one effort check) and saves the try. All
// the rules (session, class, published, these exact questions, 3 tries,
// one check at a time, the check limit) are enforced server side in
// submitAnswers; the form's own limits are only a convenience. Never
// throws, except Next's redirect: any error (the session lookup, the
// database, the model) is a message in the form, which keeps the answers,
// and the lookups before the claim have a short deadline (see
// guardAnswerCheck). Fail closed: nothing is checked when the database
// can't say it's OK.
export async function submitAnswersAction(
  readingId: string,
  _prev: AnswerFormState,
  formData: FormData,
): Promise<AnswerFormState> {
  return guardAnswerCheck((preCheck) => checkAnswers(readingId, formData, preCheck), {
    // redirect("/join") (no session) is an error Next must handle.
    rethrow: unstable_rethrow,
    onError: (error) => logError("submitAnswersAction: submit failed", safeErrorFields(error), readingId),
  });
}

async function checkAnswers(readingId: string, formData: FormData, preCheck: AbortSignal): Promise<AnswerFormState> {
  const session = await withDeadline(getStudentSession(), preCheck);
  if (!session) redirect("/join");
  // Without AI Gateway credentials every check would fail (given back,
  // but filling the outage window), so don't start one.
  if (!isQuestionWritingConfigured()) return { message: CHECK_FAILED_MESSAGE };

  const result = await submitAnswers(session.student.id, readingId, answerEntries(formData.entries()), { preCheck });
  // A saved try, or the page may have moved on: show where things stand.
  if (refreshesPage(result)) refresh(readingId);
  switch (result.status) {
    case "checked":
      return {};
    case "invalid":
      return { errors: result.errors, message: ANSWERS_FIX_MESSAGE };
    case "already_passed":
    case "out_of_tries":
    case "too_many_checks":
    case "check_failed":
      // Re-rendered above. At the check limit that's the note to the
      // teacher instead of the answer form; otherwise the form stays, with
      // its answers and this message.
      return { message: submitMessage(result.status) };
    case "timed_out":
      // Re-rendered above only when it counted (see refreshesPage).
      return TIMED_OUT_STATE;
    case "paused":
      // An outage: a short break, with when checking frees up again.
      return { limit: withRetryAt(submitMessage(result.status), result.retryAt, await requestRetryClock()) };
    default:
      return { message: submitMessage(result.status) };
  }
}

// Sends the note after the last failed try, or once every check is used.
// One per student per reading.
export async function sendChallengeAction(
  readingId: string,
  _prev: ChallengeFormState,
  formData: FormData,
): Promise<ChallengeFormState> {
  const session = await getStudentSession();
  if (!session) redirect("/join");

  let result: ChallengeResult;
  try {
    result = await sendChallenge(session.student.id, readingId, formData.get("note"));
  } catch (error) {
    logError("sendChallengeAction: send failed", safeErrorFields(error), readingId);
    return { error: CHALLENGE_FAILED_MESSAGE };
  }
  if (
    result.status === "sent" ||
    result.status === "already_sent" ||
    result.status === "already_passed" ||
    result.status === "decided"
  ) {
    // The page shows where things stand (another tab, or the teacher
    // decided meanwhile).
    refresh(readingId);
    return {};
  }
  // "busy": a check is still running in another tab. The form stays, with
  // the note, and asks to wait a minute.
  return { error: challengeMessage(result) };
}
