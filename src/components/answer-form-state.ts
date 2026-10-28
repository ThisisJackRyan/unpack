// The answer form's state, shared by the student and self-learner reading
// pages' actions. Kept out of the actions because a "use server" file may
// only export async functions.

import { CHECK_TIMED_OUT_MESSAGE } from "@/lib/validate-answers";

// After a saved check the page re-renders from the database (the new
// try's results and nudges), so a saved check returns an empty state.
// The answers themselves aren't in it: the form keeps them (and their
// drafts) until the try number changes, which only a saved check does.
export type AnswerFormState = {
  // By question id.
  errors?: Record<string, string>;
  message?: string;
  // Checking is paused (an outage): an amber note with the retry time.
  limit?: string;
  // The check took too long (the server's timed_out), or the form stopped
  // waiting for its request: `message` says which, and what to do.
  timedOut?: true;
};

export const TIMED_OUT_STATE: AnswerFormState = { timedOut: true, message: CHECK_TIMED_OUT_MESSAGE };

// The form's own messages, for a request that never answered. Unlike the
// server's timeout message, they can't say whether a try was used: the
// check may have been saved after the answer was lost.
export const CHECK_NO_REPLY_MESSAGE = "We couldn’t hear back. Your answers are still here. Reload the page to see if they were checked.";
// A deploy since the page loaded: its server action is gone.
export const APP_UPDATED_MESSAGE = "unpack was just updated. Reload the page to keep going.";

export const NO_REPLY_STATE: AnswerFormState = { timedOut: true, message: CHECK_NO_REPLY_MESSAGE };
export const APP_UPDATED_STATE: AnswerFormState = { message: APP_UPDATED_MESSAGE };

// How long the form waits for a check before it stops: 90s. The server's
// worst case is PRE_CHECK_DEADLINE_MS (10s) for the lookups, then the
// check's EFFORT_CHECK_DEADLINE_MS (60s), then the commit and the
// re-render, plus a cold start and the network both ways: about 75s. 90s
// stays clear of that, so a slow check that did finish is shown, and well
// under the reading pages' maxDuration (150s), so a request the platform
// would only end at 150s (a lost connection, a hung claim) stops sooner.
// src/components/answer-form-state.test.ts checks these numbers.
//
// Stopping only stops the waiting: a server action can't be cancelled from
// the browser, so the server goes on, bounded by its own deadlines and
// maxDuration. A check that lands after the form gave up is safe: a try is
// only saved with a successful check, and a later submit sees it (the
// answers are then "out of date", or the page has moved on). Next runs one
// server action at a time, so a submit right after the form gave up can
// wait behind the stuck one; that's why the message says to reload.
export const CLIENT_CHECK_TIMEOUT_MS = 90_000;

// Next 16's errors for a server action the server no longer has (a deploy
// between page load and click): UnrecognizedActionError on the client
// (next/dist/client/components/unrecognized-action-error.js, its name set
// explicitly, so it survives minifying), or the server's own "Failed to
// find Server Action" / "Server action not found." text. Matched narrowly:
// "An unexpected response was received from the server." is any bad
// response (a 504, say), not only a deploy.
export function isAppUpdatedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "UnrecognizedActionError" ||
    /Failed to find Server Action|Server action not found\.|failed-to-find-server-action/i.test(error.message)
  );
}

type AnswerAction = (state: AnswerFormState, formData: FormData) => Promise<AnswerFormState>;

// The action as the form calls it. If the request itself fails (the
// connection closed, the function was stopped, a 504), the action rejects
// and React would show the page's error boundary over the student's
// answers; and if it never answers, the button would spin until the
// platform gives up. Instead the form says it couldn't hear back (or that
// unpack was updated), with the answers still there. `rethrow`
// (next/navigation's unstable_rethrow in the form) lets Next's own
// redirect and not-found errors through first, so a missing session still
// goes to /join.
//
// After CLIENT_CHECK_TIMEOUT_MS the wrapper returns, so useActionState's
// transition ends and the button comes back, whatever the request does.
// Its late result, success or failure, is dropped by the race: it never
// reaches the form's state. (useActionState runs submits one at a time, so
// no older submit can overwrite a newer one.)
export function withCheckFallback(
  action: AnswerAction,
  rethrow: (error: unknown) => void,
  timeoutMs = CLIENT_CHECK_TIMEOUT_MS,
): AnswerAction {
  return async (state, formData) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<AnswerFormState>((resolve) => {
      timer = setTimeout(() => resolve(NO_REPLY_STATE), timeoutMs);
    });
    try {
      return await Promise.race([action(state, formData), gaveUp]);
    } catch (error) {
      rethrow(error);
      // The error only: never the form data or the answers.
      console.error(error);
      return isAppUpdatedError(error) ? APP_UPDATED_STATE : NO_REPLY_STATE;
    } finally {
      clearTimeout(timer);
    }
  };
}
