// The class settings form (name and grade level): its copy and the pure
// rules for the draft warning. The save is updateClassSettings in
// classes.ts, one transaction built by classGradeChangeStatements
// (shared-questions.ts), with ownership checked in it. Validation is the
// same as creating a class (validateCreateClass). Safe to import from
// client code.

import { gradeLevelLabel, type GradeLevel } from "./grade-levels";

export const CLASS_SETTINGS_FAILED_MESSAGE = "We couldn’t save that. Please try again.";

function drafts(n: number): string {
  return n === 1 ? "1 draft reading" : `${n} draft readings`;
}

// The amber note shown before saving a different grade, when drafts would
// lose their questions. Exactly what classGradeChangeStatements clears:
// the shared questions of drafts that use the class grade.
export function gradeChangeWarning(draftCount: number, newGrade: GradeLevel): string {
  return `Changing the grade clears the questions of ${drafts(draftCount)} that use the class grade, so they can be written again for ${gradeLevelLabel(newGrade)}. Published readings, and drafts with their own grade, keep their questions.`;
}

export function classSettingsSavedMessage(clearedDrafts: number): string {
  return clearedDrafts > 0 ? `Saved. Cleared the questions of ${drafts(clearedDrafts)}.` : "Saved.";
}

// Whether the warning applies to the picked grade.
export function warnsOnGradeChange(current: GradeLevel, picked: string, draftCount: number): boolean {
  return draftCount > 0 && picked !== current;
}
