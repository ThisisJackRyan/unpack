// Shared by the reading actions and form. Kept out of actions.ts because a
// "use server" file may only export async functions.
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
};
