// Grade levels a class or reading can target: kindergarten, grades 1 to 12,
// and adult learners. Stored as the "grade_level" pg enum.
export const GRADE_LEVELS = [
  "K",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "adult",
] as const;

export type GradeLevel = (typeof GRADE_LEVELS)[number];

export function isGradeLevel(value: unknown): value is GradeLevel {
  return (
    typeof value === "string" &&
    (GRADE_LEVELS as readonly string[]).includes(value)
  );
}

// Display label for a grade level: "Kindergarten", "Grade 4", "Adult".
export function gradeLevelLabel(level: GradeLevel): string {
  if (level === "K") return "Kindergarten";
  if (level === "adult") return "Adult";
  return `Grade ${level}`;
}
