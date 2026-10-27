"use server";

import { redirect } from "next/navigation";
import type { ReadingFormState } from "@/components/reading-form-state";
import { requireSelfLearner } from "@/lib/account";
import { fetchArticle } from "@/lib/fetch-article";
import { linkFetchRetryAt, recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { LINK_FETCH_LIMITED_MESSAGE } from "@/lib/link-rate-limit";
import { withRetryAt } from "@/lib/local-time";
import { requestRetryClock } from "@/lib/request-time-zone";
import { resolveReadingSource, SAVE_READING_FAILED_MESSAGE } from "@/lib/reading-source";
import type { CreateOutcome } from "@/lib/self-allowance";
import { validateSoloReadingForm } from "@/lib/self-reading-form";
import { createSelfReading, getAllowance } from "@/lib/self-readings";

// Name, code, and message only: a Postgres error's detail can echo the
// row, including the reading text.
function logDbError(where: string, error: unknown) {
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  console.error(where, { name, code, message });
}

// Starts a self-learner reading: the teacher form's validation and link
// reading (resolveReadingSource, with the account's link fetch limit),
// then the insert under the weekly allowance (race-safe, see
// self-allowance.ts). The questions are written when the reading page
// opens. At the allowance, the page itself shows the calm limit message,
// so this redirects back to it instead of returning a red form error.
export async function createSelfReadingAction(_prev: ReadingFormState, formData: FormData): Promise<ReadingFormState> {
  const account = await requireSelfLearner();
  const result = validateSoloReadingForm({
    source: formData.get("source"),
    url: formData.get("url"),
    title: formData.get("title"),
    bodyText: formData.get("bodyText"),
    gradeLevel: formData.get("gradeLevel"),
    questionCount: formData.get("questionCount"),
  });
  if (!result.ok) return { errors: result.errors, values: result.values };
  const { data, values } = result;

  // Before fetching anything: no link fetch for a reading that can't be
  // saved. The insert checks again under the lock.
  let remaining: number;
  try {
    remaining = (await getAllowance(account.id)).remaining;
  } catch (error) {
    logDbError("createSelfReadingAction: getAllowance failed", error);
    return { errors: { form: SAVE_READING_FAILED_MESSAGE }, values };
  }
  if (remaining === 0) redirect("/learn/new");

  const resolved = await resolveReadingSource(data, {
    recordLinkFetch: () => recordLinkFetchAttempt(account.id),
    limitedMessage: async () =>
      withRetryAt(LINK_FETCH_LIMITED_MESSAGE, await linkFetchRetryAt(account.id), await requestRetryClock()),
    fetchArticle: (url) => fetchArticle(url),
    log: (message, fields) => console.error(`createSelfReadingAction: ${message}`, fields),
  });
  if (!resolved.ok) return { errors: resolved.errors, values, suggestText: resolved.suggestText, limit: resolved.limit };

  // redirect() throws, so it stays outside this try.
  let outcome: CreateOutcome;
  try {
    outcome = await createSelfReading(account.id, {
      ...resolved.source,
      gradeLevel: data.gradeLevel,
      questionCount: data.questionCount,
    });
  } catch (error) {
    logDbError("createSelfReadingAction: createSelfReading failed", error);
    return { errors: { form: SAVE_READING_FAILED_MESSAGE }, values };
  }
  if (outcome.status === "created") redirect(`/learn/r/${outcome.id}`);
  if (outcome.status === "limit_reached") redirect("/learn/new");
  // Not a self-learner any more (switched in another tab).
  redirect("/home");
}
