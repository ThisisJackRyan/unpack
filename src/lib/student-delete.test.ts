import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import { deleteStudentStatement, deleteStudentWith, studentDeletedMessage } from "./student-delete";

describe("deleteStudentStatement", () => {
  it("deletes one student in the teacher's own class, in one statement", () => {
    const s = deleteStudentStatement("c1", "t1", "s1");
    assert.match(s.text, /^with owned as \(\s+select id from classes where id = \$1::uuid and teacher_id = \$2::uuid\s+\)/);
    assert.match(s.text, /delete from students s\s+using owned\s+where s\.id = \$3::uuid and s\.class_id = owned\.id/);
    assert.match(s.text, /select \(select count\(\*\) from owned\)::int as owned, \(select count\(\*\) from deleted\)::int as deleted$/);
    assert.deepEqual(s.params, ["c1", "t1", "s1"]);
  });
});

describe("deleteStudentWith", () => {
  it("runs exactly one statement (one transaction)", async () => {
    const calls: Statement[][] = [];
    const result = await deleteStudentWith("c1", "t1", "s1", async (s) => {
      calls.push(s);
      return [[{ owned: 1, deleted: 1 }]];
    });
    assert.deepEqual(result, { status: "deleted" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
  });

  it("is already_gone (a no-op success) when the class is theirs but the student isn't in it", async () => {
    assert.deepEqual(await deleteStudentWith("c1", "t1", "s1", async () => [[{ owned: 1, deleted: 0 }]]), {
      status: "already_gone",
    });
  });

  it("is not_found when the class isn't theirs", async () => {
    assert.deepEqual(await deleteStudentWith("c1", "t2", "s1", async () => [[{ owned: 0, deleted: 0 }]]), { status: "not_found" });
    assert.deepEqual(await deleteStudentWith("c1", "t2", "s1", async () => [[]]), { status: "not_found" });
  });

  it("names the student in the result", () => {
    assert.equal(studentDeletedMessage("Maya Ro"), "Deleted Maya Ro and all of their work.");
  });
});
