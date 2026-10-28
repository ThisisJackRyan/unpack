"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import type { AnswerFormState } from "@/components/answer-form-state";
import { guardAnswerCheck, PRE_CHECK_DEADLINE_MS, withDeadline } from "@/lib/answer-check-guard";
import { qaRoutesEnabled } from "@/lib/qa-routes";
import { ANSWER_FIELD_PREFIX, ANSWERS_STALE_MESSAGE } from "@/lib/validate-answers";
import { qaLastTry, saveQaTry } from "./tries";

// The posted answers by question id.
function answerTexts(formData: FormData): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith(ANSWER_FIELD_PREFIX) && typeof value === "string") texts[key.slice(ANSWER_FIELD_PREFIX.length)] = value;
  }
  return texts;
}

export type QaActionOptions = {
  sleepMs: number;
  redirect: boolean;
  // Save a try (the page moves to the next one), as a saved check does.
  advance: boolean;
  // With advance: once this run has a saved try, refuse the next submit
  // as the reading pages refuse one a saved try overtook (the server's
  // "stale", ANSWERS_STALE_MESSAGE), saving nothing.
  stale: boolean;
  // The ?run= id: which saved tries, and the server log marker.
  run: string;
  // Bound the wait as a lookup before the claim, with this deadline in
  // place of PRE_CHECK_DEADLINE_MS (null: the wait is the check itself,
  // not bounded).
  precheckMs: number | null;
};

// The QA answer form's action: no database, no model. Wrapped in the
// reading pages' guardAnswerCheck. It waits `sleepMs`, re-renders the page
// (as a saved check, or a counted timeout, does), then redirects or
// returns a result. 404 unless UNPACK_QA_ROUTES=1.
export async function qaAnswerAction(
  options: QaActionOptions,
  ...form: [prev: AnswerFormState, formData: FormData]
): Promise<AnswerFormState> {
  if (!qaRoutesEnabled()) notFound();
  // When the request reached the server: the browser check reads it to
  // tell a slow server from a slow network. The QA run id only.
  console.log(`qa-answer-action started run=${String(options.run).slice(0, 40)}`);
  const ms = Math.min(Math.max(Number(options.sleepMs) || 0, 0), 30_000);
  const bounded = options.precheckMs !== null;
  return guardAnswerCheck(
    async (preCheck) => {
      // Refused before any wait, as the reading pages refuse it at the
      // claim, before the check.
      if (options.stale && qaLastTry(options.run)) return { message: ANSWERS_STALE_MESSAGE };
      const wait = new Promise((resolve) => setTimeout(resolve, ms));
      await (bounded ? withDeadline(wait, preCheck) : wait);
      if (options.redirect) redirect("/qa/answer-timeout/landed");
      if (options.advance) saveQaTry(options.run, answerTexts(form[1]));
      revalidatePath("/qa/answer-timeout");
      const answers = [...form[1].keys()].length;
      return { message: `QA check finished after ${ms} ms, ${answers} answers.` };
    },
    {
      rethrow: unstable_rethrow,
      onError: (error) => console.error("qa-answer-action failed", (error as { name?: unknown }).name),
      deadlineMs: bounded ? options.precheckMs ?? PRE_CHECK_DEADLINE_MS : PRE_CHECK_DEADLINE_MS,
    },
  );
}
