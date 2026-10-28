"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import type { ReadingFormState } from "@/components/reading-form-state";
import { requireSelfLearner } from "@/lib/account";
import { guardCreate, readingSaveFailedState } from "@/lib/create-guard";
import { fetchArticle } from "@/lib/fetch-article";
import { linkFetchRetryAt, recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { LINK_FETCH_LIMITED_MESSAGE } from "@/lib/link-rate-limit";
import { withRetryAt } from "@/lib/local-time";
import { requestRetryClock } from "@/lib/request-time-zone";
import { createSelfReadingWith } from "@/lib/self-reading-create";
import { safeErrorFields } from "@/lib/safe-error-fields";
import { createSelfReading, getAllowance } from "@/lib/self-readings";
import { readingFormInput, readingFormValues } from "@/lib/validate-reading";

// Starts a self-learner reading (see createSelfReadingWith for the steps).
// The questions are written when the reading page opens. Never throws,
// except Next's redirects: every other failure, a lookup past
// PRE_WRITE_DEADLINE_MS included, is SAVE_READING_FAILED_MESSAGE in the
// form, with everything typed still there (see create-guard.ts).
export async function createSelfReadingAction(_prev: ReadingFormState, formData: FormData): Promise<ReadingFormState> {
  const input = readingFormInput(formData);
  const result = await guardCreate(
    (preWrite) =>
      createSelfReadingWith(input, preWrite, {
        requireAccount: requireSelfLearner,
        getAllowance: (accountId) => getAllowance(accountId),
        recordLinkFetch: (accountId) => recordLinkFetchAttempt(accountId),
        linkLimitedMessage: async (accountId) =>
          withRetryAt(LINK_FETCH_LIMITED_MESSAGE, await linkFetchRetryAt(accountId), await requestRetryClock()),
        fetchArticle: (url) => fetchArticle(url),
        createSelfReading: (accountId, draft) => createSelfReading(accountId, draft),
        log: (message, fields) => console.error(`createSelfReadingAction: ${message}`, fields),
      }),
    () => ({ state: readingSaveFailedState(readingFormValues(input)) }),
    {
      // requireSelfLearner's redirects are errors Next must handle.
      rethrow: unstable_rethrow,
      onError: (error) => console.error("createSelfReadingAction: create failed", safeErrorFields(error)),
    },
  );
  if ("state" in result) return result.state;
  // Always a replace (createOutcomeRedirect): Back from the new reading
  // goes to /learn, not to the filled-in form.
  const next = result.redirect;
  redirect(next.path, next.type);
}
