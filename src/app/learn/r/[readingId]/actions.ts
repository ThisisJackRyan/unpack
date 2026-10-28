"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { TIMED_OUT_STATE, type AnswerFormState } from "@/components/answer-form-state";
import { requireSelfLearner } from "@/lib/account";
import { guardAnswerCheck, withDeadline } from "@/lib/answer-check-guard";
import { isQuestionWritingConfigured } from "@/lib/ai/client";
import { soloSubmitMessage } from "@/lib/self-answers-core";
import { submitSelfAnswers } from "@/lib/self-readings";
import { CHECK_FAILED_MESSAGE, refreshesPage } from "@/lib/submit-answers-core";
import { withRetryAt } from "@/lib/local-time";
import { requestRetryClock } from "@/lib/request-time-zone";
import { safeErrorFields } from "@/lib/safe-error-fields";
import { ANSWERS_FIX_MESSAGE, answerEntries } from "@/lib/validate-answers";

// Checks every answer at once (one effort check) and saves the try, with
// all the student rules enforced in submitSelfAnswers (owner, these exact
// questions, 3 tries, one check at a time, the check limit). After the
// last try the page shows the nudges and a way to move on. Never throws,
// except Next's redirects, as the student reading page's action.
export async function submitSelfAnswersAction(
  readingId: string,
  _prev: AnswerFormState,
  formData: FormData,
): Promise<AnswerFormState> {
  return guardAnswerCheck((preCheck) => checkSelfAnswers(readingId, formData, preCheck), {
    // requireSelfLearner's redirects are errors Next must handle.
    rethrow: unstable_rethrow,
    // Safe fields only (safe-error-fields.ts): an error's message can echo
    // an answer.
    onError: (error) => console.error("submitSelfAnswersAction: submit failed", { ...safeErrorFields(error), readingId }),
  });
}

async function checkSelfAnswers(readingId: string, formData: FormData, preCheck: AbortSignal): Promise<AnswerFormState> {
  // Its redirects (signed out, not a self-learner) come through the
  // deadline as they are.
  const account = await withDeadline(requireSelfLearner(), preCheck);
  // Without AI Gateway credentials every check would fail (given back,
  // but filling the outage window), so don't start one.
  if (!isQuestionWritingConfigured()) return { message: CHECK_FAILED_MESSAGE };

  const result = await submitSelfAnswers(account.id, readingId, answerEntries(formData.entries()), { preCheck });
  // A saved try, or the page may have moved on: show where things stand.
  if (refreshesPage(result)) {
    revalidatePath(`/learn/r/${readingId}`);
    revalidatePath("/learn");
  }
  switch (result.status) {
    case "checked":
      return {};
    case "invalid":
      return { errors: result.errors, message: ANSWERS_FIX_MESSAGE };
    case "already_passed":
    case "out_of_tries":
    case "too_many_checks":
    case "check_failed":
      return { message: soloSubmitMessage(result.status) };
    case "timed_out":
      // Re-rendered above only when it counted (see refreshesPage).
      return TIMED_OUT_STATE;
    case "paused":
      // An outage: a short break, with when checking frees up again.
      return { limit: withRetryAt(soloSubmitMessage(result.status), result.retryAt, await requestRetryClock()) };
    default:
      return { message: soloSubmitMessage(result.status) };
  }
}
