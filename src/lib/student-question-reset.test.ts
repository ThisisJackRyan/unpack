import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import {
  RESET_TRIES_FAILED_MESSAGE,
  resetStudentQuestionCallsStatement,
  resetStudentQuestionCallsWith,
  resetTriesMessage,
} from "./student-question-reset";

describe("resetStudentQuestionCallsStatement", () => {
  const s = resetStudentQuestionCallsStatement("c1", "t1", "s1", "r1");

  it("finds the student only in the teacher's own class, with the reading in that class", () => {
    assert.match(s.text, /join classes c on c\.id = s\.class_id\s+join readings r on r\.class_id = c\.id/);
    assert.match(s.text, /where c\.id = \$1::uuid and c\.teacher_id = \$2::uuid\s+and s\.id = \$3::uuid and r\.id = \$4::uuid/);
    assert.deepEqual(s.params, ["c1", "t1", "s1", "r1"]);
  });

  it("clears only that student's calls for that reading, sparing a call still running", () => {
    assert.match(s.text, /delete from student_question_calls q\s+using owned\s+where q\.student_id = owned\.id and q\.reading_id = \$4::uuid/);
    assert.match(s.text, /not exists \([\s\S]*g\.status = 'pending' and g\.claimed_at = q\.created_at/);
  });

  it("says whether the student was found and how many rows it cleared", () => {
    assert.match(s.text, /select \(select count\(\*\) from owned\)::int as owned, \(select count\(\*\) from cleared\)::int as cleared$/);
  });
});

describe("resetStudentQuestionCallsWith", () => {
  it("runs exactly one statement (one transaction) and reports the reset", async () => {
    const calls: Statement[][] = [];
    const result = await resetStudentQuestionCallsWith("c1", "t1", "s1", "r1", async (s) => {
      calls.push(s);
      return [[{ owned: 1, cleared: 6 }]];
    });
    assert.deepEqual(result, { status: "reset", cleared: 6 });
    assert.deepEqual([calls.length, calls[0].length], [1, 1]);
  });

  it("a repeat click is a no-op success", async () => {
    assert.deepEqual(await resetStudentQuestionCallsWith("c1", "t1", "s1", "r1", async () => [[{ owned: 1, cleared: 0 }]]), {
      status: "reset",
      cleared: 0,
    });
  });

  it("is not_found for another teacher or ids outside the class", async () => {
    assert.deepEqual(await resetStudentQuestionCallsWith("c1", "t2", "s1", "r1", async () => [[{ owned: 0, cleared: 0 }]]), {
      status: "not_found",
    });
    assert.deepEqual(await resetStudentQuestionCallsWith("c1", "t2", "s1", "r1", async () => [[]]), { status: "not_found" });
  });

  it("has calm copy with curly apostrophes", () => {
    assert.equal(resetTriesMessage("Maya Ro"), "Done. Maya Ro can try again now.");
    assert.equal(RESET_TRIES_FAILED_MESSAGE, "We couldn’t do that. Please try again.");
  });
});
