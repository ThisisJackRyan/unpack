// Groups a per-student reading's saved question rows by student, for the
// teacher's reading page. Pure, so tests can check it.

export type StudentSetRow = {
  studentId: string;
  firstName: string;
  lastInitials: string;
  questionId: string;
  position: number;
  prompt: string;
};

export type StudentSet = {
  studentId: string;
  name: string;
  questions: { id: string; position: number; prompt: string }[];
};

// "Maya Ro": what the student typed, as they appear to the teacher.
export function studentDisplayName(firstName: string, lastInitials: string): string {
  return `${firstName} ${lastInitials}`;
}

// Keeps the rows' student order; sorts each set by position.
export function groupStudentSets(rows: StudentSetRow[]): StudentSet[] {
  const sets = new Map<string, StudentSet>();
  for (const row of rows) {
    let set = sets.get(row.studentId);
    if (!set) {
      set = {
        studentId: row.studentId,
        name: studentDisplayName(row.firstName, row.lastInitials),
        questions: [],
      };
      sets.set(row.studentId, set);
    }
    set.questions.push({ id: row.questionId, position: row.position, prompt: row.prompt });
  }
  for (const set of sets.values()) set.questions.sort((a, b) => a.position - b.position);
  return [...sets.values()];
}
