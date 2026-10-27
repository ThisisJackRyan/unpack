import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import { deleteReadingStatement, deleteReadingWith, READING_DELETED_MESSAGE } from "./reading-delete";

describe("deleteReadingStatement", () => {
  it("deletes one reading in the teacher's own class, in one statement", () => {
    const s = deleteReadingStatement("c1", "t1", "r1");
    assert.match(s.text, /^with owned as \(\s+select id from classes where id = \$1::uuid and teacher_id = \$2::uuid\s+\)/);
    assert.match(s.text, /delete from readings r\s+using owned\s+where r\.id = \$3::uuid and r\.class_id = owned\.id/);
    assert.match(s.text, /select \(select count\(\*\) from owned\)::int as owned, \(select count\(\*\) from deleted\)::int as deleted$/);
    assert.deepEqual(s.params, ["c1", "t1", "r1"]);
  });

  it("never puts ids in the SQL", () => {
    const s = deleteReadingStatement("c-id", "t-id", "r-id");
    assert.equal(/c-id|t-id|r-id/.test(s.text), false);
  });
});

describe("deleteReadingWith", () => {
  it("runs exactly one statement (one transaction)", async () => {
    const calls: Statement[][] = [];
    const result = await deleteReadingWith("c1", "t1", "r1", async (s) => {
      calls.push(s);
      return [[{ owned: 1, deleted: 1 }]];
    });
    assert.deepEqual(result, { status: "deleted" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
  });

  it("is already_gone (a quiet success) when the class is theirs but the reading isn't in it", async () => {
    assert.deepEqual(await deleteReadingWith("c1", "t1", "r1", async () => [[{ owned: 1, deleted: 0 }]]), { status: "already_gone" });
  });

  it("is not_found when the class isn't theirs", async () => {
    assert.deepEqual(await deleteReadingWith("c1", "t2", "r1", async () => [[{ owned: 0, deleted: 0 }]]), { status: "not_found" });
    assert.deepEqual(await deleteReadingWith("c1", "t2", "r1", async () => [[]]), { status: "not_found" });
  });

  it("says what went", () => {
    assert.equal(READING_DELETED_MESSAGE, "Reading deleted, with its questions and every student’s answers and tries.");
  });
});
