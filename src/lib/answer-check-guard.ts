// The answer actions' outer shell, shared by the student and self-learner
// reading pages: everything before the check's claim gets a short
// deadline, and nothing the action does reaches the client as a rejected
// promise except Next's own redirect and not-found errors. Pure (the
// action passes Next's unstable_rethrow and its logger), so tests run it
// with fakes.

import { TIMED_OUT_STATE, type AnswerFormState } from "@/components/answer-form-state";
import { DeadlineError } from "./deadline";

export { DeadlineError, withDeadline } from "./deadline";

export const SUBMIT_FAILED_MESSAGE = "Something went wrong. Try again.";

// The lookups before the claim (the session or sign-in, the reading, the
// questions, the tries so far) normally take well under a second, a cold
// database a few. Nothing that matters is written before the claim (a
// self-learner's first visit may upsert their account row, which is
// idempotent), so giving up here costs nothing: the student sees the timeout message and the next submit
// starts fresh. The claim itself is not bounded (it writes the
// effort_checks row: one that landed after we gave up would hold a check
// until it goes stale), nor is the check (EFFORT_CHECK_DEADLINE_MS bounds
// it). src/lib/function-budget.test.ts adds this up.
export const PRE_CHECK_DEADLINE_MS = 10_000;

export type GuardOptions = {
  // next/navigation's unstable_rethrow: Next's redirect and not-found
  // errors must reach Next.
  rethrow: (error: unknown) => void;
  // Logs safe fields only (never answers or names).
  onError: (error: unknown) => void;
  deadlineMs?: number;
};

// Runs the check with a pre-check signal (pass it to withDeadline for each
// lookup before the claim). A lookup past the deadline is the timeout
// message; any other error is "Something went wrong", with the form and
// its answers still there.
export async function guardAnswerCheck(
  run: (preCheck: AbortSignal) => Promise<AnswerFormState>,
  { rethrow, onError, deadlineMs = PRE_CHECK_DEADLINE_MS }: GuardOptions,
): Promise<AnswerFormState> {
  try {
    return await run(AbortSignal.timeout(deadlineMs));
  } catch (error) {
    rethrow(error);
    onError(error);
    return error instanceof DeadlineError ? TIMED_OUT_STATE : { message: SUBMIT_FAILED_MESSAGE };
  }
}
