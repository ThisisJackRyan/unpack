import { isGradeLevel, type GradeLevel } from "./grade-levels";

// Pure validation for the create-class form, shared by the server action and
// tests. Safe to import from client code.

export const CLASS_NAME_MAX_LENGTH = 60;

export type CreateClassErrors = { name?: string; gradeLevel?: string };

export type CreateClassValidation =
  | {
      ok: true;
      data: { name: string; gradeLevel: GradeLevel };
      values: { name: string; gradeLevel: string };
    }
  | {
      ok: false;
      errors: CreateClassErrors;
      values: { name: string; gradeLevel: string };
    };

// Takes raw FormData values. The name is trimmed; `values` echoes what the
// form should show again after an error.
export function validateCreateClass(input: {
  name: unknown;
  gradeLevel: unknown;
}): CreateClassValidation {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const gradeLevel =
    typeof input.gradeLevel === "string" ? input.gradeLevel : "";
  const values = { name, gradeLevel };

  const errors: CreateClassErrors = {};
  if (!name) {
    errors.name = "Enter a class name.";
  } else if (name.length > CLASS_NAME_MAX_LENGTH) {
    errors.name = `Keep the name to ${CLASS_NAME_MAX_LENGTH} characters or less.`;
  }
  if (!isGradeLevel(gradeLevel)) {
    errors.gradeLevel = "Choose a grade level.";
  }
  if (errors.name || !isGradeLevel(gradeLevel)) {
    return { ok: false, errors, values };
  }
  return { ok: true, data: { name, gradeLevel }, values };
}
