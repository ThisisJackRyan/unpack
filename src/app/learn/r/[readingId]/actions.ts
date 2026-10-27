"use server";

import { revalidatePath } from "next/cache";
import type { AnswerFormState } from "@/components/answer-form-state";
import { requireSelfLearner } from "@/lib/account";
import { isQuestionWritingConfigured } from "@/lib/ai/client";
import { soloSubmitMessage } from "@/lib/self-answers-core";
import { submitSelfAnswers } from "@/lib/self-readings";
import { CHECK_FAILED_MESSAGE, type SubmitResult } from "@/lib/submit-answers-core";
import { ANSWERS_FIX_MESSAGE, answerEntries } from "@/lib/validate-answers";

const SUBMIT_FAILED_MESSAGE = "Something went wrong. Try again.";

// Checks every answer at once (one effort check) and saves the try, with
// all the student rules enforced in submitSelfAnswers (owner, these exact
// questions, 3 tries, one check at a time, the check limit). After the
// last try the page shows the nudges and a way to move on.
export async function submitSelfAnswersAction(
  readingId: string,
  _prev: AnswerFormState,
  formData: FormData,
): Promise<AnswerFormState> {
  const account = await requireSelfLearner();
  // Without AI Gateway credentials every check would fail and still count
  // toward the limit.
  if (!isQuestionWritingConfigured()) return { message: CHECK_FAILED_MESSAGE };

  let result: SubmitResult;
  try {
    result = await submitSelfAnswers(account.id, readingId, answerEntries(formData.entries()));
  } catch (error) {
    // Name, code, and message only: an error's detail can echo an answer.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("submitSelfAnswersAction: submit failed", { name, code, message, readingId });
    return { message: SUBMIT_FAILED_MESSAGE };
  }

  const refresh = () => {
    revalidatePath(`/learn/r/${readingId}`);
    revalidatePath("/learn");
  };
  switch (result.status) {
    case "checked":
      refresh();
      return {};
    case "invalid":
      return { errors: result.errors, message: ANSWERS_FIX_MESSAGE };
    case "already_passed":
    case "out_of_tries":
    case "too_many_checks":
    case "check_failed":
      refresh();
      return { message: soloSubmitMessage(result.status) };
    default:
      return { message: soloSubmitMessage(result.status) };
  }
}
