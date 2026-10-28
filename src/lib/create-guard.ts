// The outer shell of the actions that create or publish something: the
// self-learner's new reading (/learn/new), a teacher's new reading, and
// the teacher's questions panel (Publish among its buttons). The same
// idea as guardAnswerCheck (answer-check-guard.ts): every lookup before
// the first write gets a short deadline, and nothing the action does
// reaches the client as a rejected promise except Next's own redirect and
// not-found errors. A rejected server action call is thrown into render
// by useActionState and lands on the page's error boundary, with what the
// user typed gone: that was the bug on /learn/new (a throw from the
// account lookup, outside any try). Pure (the action passes Next's
// unstable_rethrow and its logger), so tests run it with fakes.
//
// What is bounded, and what isn't:
// - The lookups before the first write (the account or teacher, the
//   class, the allowance, the link limit's retry time) go through
//   withDeadline(…, preWrite). Nothing that matters is written before
//   them (a first visit may upsert the account row, which is idempotent),
//   so giving up there costs nothing, and SAVE_READING_FAILED_MESSAGE is
//   true: nothing was saved.
// - The first write is never cut: the create transaction (which is also
//   what takes the weekly slot, see self-allowance.ts), the link fetch
//   record, the publish. An abandoned write's outcome can't be known (see
//   src/db/read-timeout.ts). The link fetch keeps its own deadline
//   (FETCH_DEADLINE_MS).
// - A database read past DB_READ_TIMEOUT_MS anywhere is a failure like
//   any other here.

import type { ReadingFormState } from "@/components/reading-form-state";
import { isDbReadTimeout } from "@/db/read-timeout";
import { DeadlineError } from "./deadline";
import { SAVE_READING_FAILED_MESSAGE } from "./reading-source";
import type { ReadingFormValues } from "./validate-reading";

export { DeadlineError, withDeadline } from "./deadline";

// The lookups before the first write normally take well under a second, a
// cold database a few: the same bound as before an answer check's claim
// (PRE_CHECK_DEADLINE_MS). src/lib/function-budget.test.ts adds up the
// routes that use it.
export const PRE_WRITE_DEADLINE_MS = 10_000;

// timed_out: a lookup before the first write passed its deadline, or a
// database read its timeout. failed: anything else that threw.
export type CreateFailure = "timed_out" | "failed";

export type CreateGuardOptions = {
  // next/navigation's unstable_rethrow: Next's redirect and not-found
  // errors must reach Next.
  rethrow: (error: unknown) => void;
  // Logs safe fields only (never the text, a title, or a name).
  onError: (error: unknown) => void;
  deadlineMs?: number;
};

export function failureKind(error: unknown): CreateFailure {
  return error instanceof DeadlineError || isDbReadTimeout(error) ? "timed_out" : "failed";
}

// Runs the action with a pre-write signal (pass it to withDeadline for
// each lookup before the first write). Any error but Next's own is
// logged and becomes `failed(kind)`, an in-form state.
export async function guardCreate<S>(
  run: (preWrite: AbortSignal) => Promise<S>,
  failed: (kind: CreateFailure) => S,
  { rethrow, onError, deadlineMs = PRE_WRITE_DEADLINE_MS }: CreateGuardOptions,
): Promise<S> {
  try {
    return await run(AbortSignal.timeout(deadlineMs));
  } catch (error) {
    rethrow(error);
    onError(error);
    return failed(failureKind(error));
  }
}

// A reading form's state for a create that failed before anything was
// saved, timed out or not: the form keeps every value it sent. A timeout
// says the same as any other failure: nothing was saved (and no weekly
// slot used), so "try again" is the whole story.
export function readingSaveFailedState(values: ReadingFormValues): ReadingFormState {
  return { errors: { form: SAVE_READING_FAILED_MESSAGE }, values };
}

// Name, code and message only: a Postgres error's detail can echo the row,
// including the reading text. Never the form's values.
export function safeErrorFields(error: unknown): { name: unknown; code: unknown; message: unknown } {
  const { name, code, message } = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  return { name, code, message };
}
