// Validation for the self-learner's new reading form: the teacher's form
// rules (validateReadingForm: link or text, title, text length, question
// count), plus a reading level that must be chosen (there is no class
// grade to fall back on). Question mode doesn't apply: a self-learner's
// questions are always their own. Pure, safe to import from client code.

import type { GradeLevel } from "./grade-levels";
import {
  validateReadingForm,
  type ReadingFormData,
  type ReadingFormErrors,
  type ReadingFormValues,
} from "./validate-reading";

export const SOLO_GRADE_REQUIRED_MESSAGE = "Choose a reading level.";

export type SoloReadingFormValidation =
  | { ok: true; data: ReadingFormData & { gradeLevel: GradeLevel }; values: ReadingFormValues }
  | { ok: false; errors: ReadingFormErrors; values: ReadingFormValues };

export function validateSoloReadingForm(input: {
  source: unknown;
  url: unknown;
  title: unknown;
  bodyText: unknown;
  gradeLevel: unknown;
  questionCount: unknown;
}): SoloReadingFormValidation {
  // "shared" only to satisfy the shared validator; it isn't stored.
  const result = validateReadingForm({ ...input, questionMode: "shared" });
  const errors: ReadingFormErrors = result.ok ? {} : { ...result.errors };
  if (!errors.gradeLevel && result.values.gradeLevel === "") errors.gradeLevel = SOLO_GRADE_REQUIRED_MESSAGE;
  if (!result.ok || Object.keys(errors).length > 0 || result.data.gradeLevel === null) {
    return { ok: false, errors, values: result.values };
  }
  return { ok: true, data: { ...result.data, gradeLevel: result.data.gradeLevel }, values: result.values };
}
