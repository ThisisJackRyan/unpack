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
  // The check took too long, or its request never came back: `message`
  // says so, and no try was used.
  timedOut?: true;
};

export const TIMED_OUT_STATE: AnswerFormState = { timedOut: true, message: CHECK_TIMED_OUT_MESSAGE };

type AnswerAction = (state: AnswerFormState, formData: FormData) => Promise<AnswerFormState>;

// The action as the form calls it. If the request itself fails (the
// connection closed, the function was stopped, a 504), the action rejects
// and React would show the page's error boundary over the student's
// answers; instead the form says it took too long, with the answers still
// there. `rethrow` (next/navigation's unstable_rethrow in the form) lets
// Next's own redirect and not-found errors through first, so a missing
// session still goes to /join.
export function withCheckFallback(action: AnswerAction, rethrow: (error: unknown) => void): AnswerAction {
  return async (state, formData) => {
    try {
      return await action(state, formData);
    } catch (error) {
      rethrow(error);
      return TIMED_OUT_STATE;
    }
  };
}
