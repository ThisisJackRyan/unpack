// Shared by the reading actions (teacher and self-learner) and the reading
// form. Kept out of the actions because a "use server" file may only export
// async functions.
import type {
  ReadingFormErrors,
  ReadingFormValues,
} from "@/lib/validate-reading";

export {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_MIN_LENGTH,
  BODY_TEXT_TOO_LONG_MESSAGE,
  normalizeBodyText,
  QUESTION_COUNT_DEFAULT,
  QUESTION_COUNT_MAX,
  QUESTION_COUNT_MIN,
  READING_TITLE_MAX_LENGTH,
  SOURCE_URL_MAX_LENGTH,
} from "@/lib/validate-reading";
export type { ReadingFormValues } from "@/lib/validate-reading";

export type ReadingFormState = {
  errors?: ReadingFormErrors & { form?: string };
  values?: ReadingFormValues;
  // Set when a link couldn't be read: the form shows this after the link
  // error as a control that switches to "Paste text".
  suggestText?: string;
  // At the link limit: an amber note with the retry time.
  limit?: string;
};

// The new reading forms' message for a create that got no answer (the
// connection dropped, a 504, a sign-in that lapsed): the reading may or may
// not have been saved. The form makes "Check your readings" a link to the
// readings list (see noReplyParts in reading-form-fallback.ts).
export const CREATE_NO_REPLY_MESSAGE =
  "We couldn’t hear back. Your reading may have saved anyway. What you typed is still here. Check your readings before you try again.";
