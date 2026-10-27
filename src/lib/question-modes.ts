// How a reading's questions are made, stored as the "question_mode" pg enum.
// Shared: one set, generated once, that the teacher can review and edit.
// Per student: each student gets their own set when they first open it.
export const QUESTION_MODES = ["shared", "per_student"] as const;

export type QuestionMode = (typeof QUESTION_MODES)[number];

export function isQuestionMode(value: unknown): value is QuestionMode {
  return (
    typeof value === "string" &&
    (QUESTION_MODES as readonly string[]).includes(value)
  );
}

export function questionModeLabel(mode: QuestionMode): string {
  return mode === "shared" ? "Same for everyone" : "Unique per student";
}

export function questionModeHint(mode: QuestionMode): string {
  return mode === "shared"
    ? "Made once. You can review and edit them."
    : "Each student gets their own set. Harder to share answers.";
}

// "1 question", "3 questions".
export function questionCountLabel(count: number): string {
  return count === 1 ? "1 question" : `${count} questions`;
}
