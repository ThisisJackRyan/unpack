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
};

// The check took too long (the server's timed_out, or a lookup before the
// claim): try again.
export const TIMED_OUT_STATE: AnswerFormState = { message: CHECK_TIMED_OUT_MESSAGE };

// The form's own messages, for a request that never answered. Unlike the
// server's timeout message, they can't say whether a try was used: the
// check may have been saved after the answer was lost.
export const CHECK_NO_REPLY_MESSAGE = "We couldn’t hear back. Your answers are still here. Reload the page to see if they were checked.";
// A deploy since the page loaded: its server action is gone.
export const APP_UPDATED_MESSAGE = "unpack was just updated. Reload the page to keep going.";

export const NO_REPLY_STATE: AnswerFormState = { message: CHECK_NO_REPLY_MESSAGE };
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
// connection closed, the function was stopped, a 504), the action rejects;
// and if it never answers, the button would spin until the platform gives
// up. Instead the form says it couldn't hear back (or that unpack was
// updated), with the answers still there. `rethrow` (next/navigation's
// unstable_rethrow in the form) lets Next's own redirect and not-found
// errors through first, so a missing session still goes to /join.
//
// After `timeoutMs` (CLIENT_CHECK_TIMEOUT_MS) the wrapper returns the
// no-reply state, whatever the request does. Its late result, success or
// failure, is dropped by the race. For that to reach the screen, the form
// must not run this inside a transition (see submitCheck).
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
      // The error only: never the form data or the answers. This runs in
      // the student's own browser, where Next sends a server error as a
      // generic message and a digest, never its text, and the server-side
      // helper (safe-error-fields.ts, with drizzle) isn't bundled.
      // eslint-disable-next-line unpack/no-raw-error-log -- browser only, see above
      console.error(error);
      return isAppUpdatedError(error) ? APP_UPDATED_STATE : NO_REPLY_STATE;
    } finally {
      clearTimeout(timer);
    }
  };
}

// Next's redirect error, as next/dist/client/components/redirect-error.js
// checks it: a digest "NEXT_REDIRECT;push|replace;<url>;<status>;".
export function isNextRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && /^NEXT_REDIRECT;(push|replace);/.test(digest);
}

// The form's submits: a sequence number, bumped by each one, and whether
// one is running. Kept in a ref, so a second click is refused at once.
export type CheckRun = { seq: number; pending: boolean };

export type CheckHandlers = {
  start: () => void;
  result: (state: AnswerFormState) => void;
  // Next's not-found and the like (never a redirect): the form throws it
  // into render, for the page's boundary, as useActionState did.
  error: (error: unknown) => void;
};

// Runs one submit. The form calls this from its submit handler, not in
// startTransition or through useActionState: React 19 entangles a
// transition's update with any pending async transition, and Next's
// callServer dispatches the server action as one. So a transition's "gave
// up" would only reach the screen once the request itself settled, which
// for a hung request is the platform's 504 at 150s, or never. Plain state
// updates from here commit as soon as the race ends.
//
// A result or error for an older submit (`seq` moved on) touches nothing.
// A redirect leaves the form pending: Next's server-action reducer
// (next/dist/client/components/router-reducer/reducers/server-action-reducer.js,
// Next 16.2.11) already navigates on its own, however the action was
// called, and then rejects the call's promise with the redirect error.
// A revalidatePath in the action also reaches the page through that
// reducer, so the page re-renders with where things stand.
export async function submitCheck(
  run: CheckRun,
  check: () => Promise<AnswerFormState>,
  on: CheckHandlers,
): Promise<void> {
  if (run.pending) return;
  const seq = ++run.seq;
  run.pending = true;
  on.start();
  try {
    const state = await check();
    if (run.seq !== seq) return;
    run.pending = false;
    on.result(state);
  } catch (error) {
    if (run.seq !== seq || isNextRedirect(error)) return;
    run.pending = false;
    on.error(error);
  }
}

// The boxes when the page moves to a new try (a check was saved, and the
// page re-rendered). Normally that's the new try's answers (`prefilled`):
// the answers just checked. But a check can land after the form stopped
// waiting, while the student is already changing their answers: then
// replacing the boxes would throw that typing away. So if they edited
// since their last submit, the boxes keep what they typed (`current`); the
// new try's results and tips still show around them.
export function valuesForNewTry(
  prefilled: Record<string, string>,
  current: Record<string, string>,
  editedSinceSubmit: boolean,
): Record<string, string> {
  return editedSinceSubmit ? { ...prefilled, ...current } : prefilled;
}
