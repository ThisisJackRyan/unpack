import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupStudentSets, studentDisplayName } from "./student-sets";

const row = (studentId: string, position: number, firstName = "Maya", lastInitials = "Ro") => ({
  studentId,
  firstName,
  lastInitials,
  questionId: `${studentId}-${position}`,
  position,
  prompt: `Q${position}`,
});

describe("groupStudentSets", () => {
  it("groups rows by student, keeping student order and sorting positions", () => {
    const sets = groupStudentSets([row("a", 2), row("a", 1), row("b", 1, "Leo", "M"), row("a", 3)]);
    assert.deepEqual(
      sets.map((s) => [s.name, s.questions.map((q) => q.position)]),
      [
        ["Maya Ro", [1, 2, 3]],
        ["Leo M", [1]],
      ],
    );
  });

  it("is empty with no rows", () => {
    assert.deepEqual(groupStudentSets([]), []);
  });

  it("shows first name and last initials", () => {
    assert.equal(studentDisplayName("Maya", "Ro"), "Maya Ro");
  });
});
