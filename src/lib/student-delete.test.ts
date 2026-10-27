import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import { deleteStudentStatement, deleteStudentWith, studentDeletedMessage } from "./student-delete";

describe("deleteStudentStatement", () => {
  it("deletes one student in the teacher's own class, in one statement", () => {
    const s = deleteStudentStatement("c1", "t1", "s1");
    assert.match(s.text, /^delete from students s\s+using classes c/);
    assert.match(s.text, /s\.id = \$3::uuid and s\.class_id = \$1::uuid/);
    assert.match(s.text, /c\.id = s\.class_id and c\.teacher_id = \$2::uuid/);
    assert.match(s.text, /returning s\.id$/);
    assert.deepEqual(s.params, ["c1", "t1", "s1"]);
  });
});

describe("deleteStudentWith", () => {
  it("runs exactly one statement (one transaction)", async () => {
    const calls: Statement[][] = [];
    const result = await deleteStudentWith("c1", "t1", "s1", async (s) => {
      calls.push(s);
      return [[{ id: "s1" }]];
    });
    assert.deepEqual(result, { status: "deleted" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
  });

  it("is not_found when nothing matched (another teacher, or already deleted)", async () => {
    assert.deepEqual(await deleteStudentWith("c1", "t2", "s1", async () => [[]]), { status: "not_found" });
  });

  it("names the student in the result", () => {
    assert.equal(studentDeletedMessage("Maya Ro"), "Deleted Maya Ro and all of their work.");
  });
});
