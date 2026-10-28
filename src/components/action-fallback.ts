// A form action as the form calls it, for the forms that create or save
// without a client time limit (the reading forms, the questions panel).
// If the request itself fails (the connection closed, a 504, Clerk's
// middleware answering 401 to a lapsed session, a deploy since the page
// loaded), the action call rejects, and useActionState would throw that
// into render: the page's error boundary, with what was typed gone. This
// turns the rejection into the form's own state instead. `rethrow`
// (next/navigation's unstable_rethrow in the form) lets Next's redirect
// and not-found errors through first, so a saved reading still opens and
// a missing session still goes to sign-in. Like withCheckFallback
// (answer-form-state.ts), minus the time limit.

import { isAppUpdatedError } from "./answer-form-state";

// app_updated: the server no longer has this action (APP_UPDATED_MESSAGE
// fits). no_reply: anything else; whether the server did the work is
// unknown.
export type RejectionKind = "app_updated" | "no_reply";

export function rejectionKind(error: unknown): RejectionKind {
  return isAppUpdatedError(error) ? "app_updated" : "no_reply";
}

export function withRejectionFallback<S>(
  action: (state: S, formData: FormData) => Promise<S>,
  fallback: (kind: RejectionKind, formData: FormData, state: S) => S,
  rethrow: (error: unknown) => void,
): (state: S, formData: FormData) => Promise<S> {
  return async (state, formData) => {
    try {
      return await action(state, formData);
    } catch (error) {
      rethrow(error);
      // The kind and the error's name only: never the form data, the
      // error's message, or its stack. This runs in the browser, where
      // safe-error-fields.ts (server only: drizzle, node:crypto) isn't
      // bundled.
      console.error("form action rejected", {
        kind: rejectionKind(error),
        name: error instanceof Error ? error.name : typeof error,
      });
      return fallback(rejectionKind(error), formData, state);
    }
  };
}
