import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAP_NEAR_THRESHOLD,
  capAlreadyRaisedMessage,
  capHeadline,
  capRaisedMessage,
  capView,
  raiseCapStatement,
  raiseReadingCapWith,
  readingCapFromRows,
  readingCapStatement,
} from "./reading-cap";
import { STUDENT_SETS_PER_READING_LIMIT, STUDENT_SETS_RAISED_LIMIT } from "./student-questions-core";

describe("raiseCapStatement", () => {
  const s = raiseCapStatement("c1", "t1", "r1");

  it("raises only the owner's published per-student reading, once, in one statement", () => {
    assert.match(s.text, /where r\.id = \$3::uuid and r\.class_id = \$1::uuid and c\.teacher_id = \$2::uuid/);
    assert.match(s.text, /r\.status = 'published' and r\.question_mode = 'per_student'/);
    assert.match(s.text, /insert into reading_cap_raises \(reading_id, teacher_id, from_limit, to_limit\)\s+select id, \$2::uuid, \$4::int, \$5::int from owned\s+on conflict \(reading_id\) do nothing/);
    assert.deepEqual(s.params, ["c1", "t1", "r1", 150, 300]);
  });

  it("is 150 to 300", () => {
    assert.equal(STUDENT_SETS_PER_READING_LIMIT, 150);
    assert.equal(STUDENT_SETS_RAISED_LIMIT, 300);
  });
});

describe("raiseReadingCapWith", () => {
  it("reads raised, already raised, and not found", async () => {
    let n = 0;
    const raised = await raiseReadingCapWith("c1", "t1", "r1", async (st) => {
      n += st.length;
      return [[{ owned: 1, raised: 1, to_limit: 300 }]];
    });
    assert.deepEqual(raised, { status: "raised", limit: 300 });
    assert.equal(n, 1);
    assert.deepEqual(await raiseReadingCapWith("c1", "t1", "r1", async () => [[{ owned: 1, raised: 0, to_limit: null }]]), {
      status: "already_raised",
      limit: 300,
    });
    assert.deepEqual(await raiseReadingCapWith("c1", "t2", "r1", async () => [[{ owned: 0, raised: 0 }]]), { status: "not_found" });
    assert.deepEqual(await raiseReadingCapWith("c1", "t2", "r1", async () => [[]]), { status: "not_found" });
  });
});

describe("the reading's cap", () => {
  it("counts claims against the raised cap, else the default, scoped to the owner", () => {
    const s = readingCapStatement("c1", "t1", "r1");
    assert.match(s.text, /count\(\*\)::int from question_generations g where g\.reading_id = r\.id\) as used/);
    assert.match(s.text, /coalesce\(\(select x\.to_limit from reading_cap_raises x where x\.reading_id = r\.id\), \$4::int\)::int as cap/);
    assert.match(s.text, /c\.teacher_id = \$2::uuid/);
    assert.deepEqual(s.params, ["c1", "t1", "r1", 150]);
    assert.deepEqual(readingCapFromRows([[{ used: 12, cap: 150, raised: false }]]), { used: 12, limit: 150, raised: false });
    assert.equal(readingCapFromRows([[]]), undefined);
  });

  it("shows nothing well under the cap, a note and the button near and at it, the new limit after", () => {
    assert.equal(CAP_NEAR_THRESHOLD, 135);
    assert.deepEqual(capView({ used: 0, limit: 150, raised: false }), { kind: "none" });
    assert.deepEqual(capView({ used: 134, limit: 150, raised: false }), { kind: "none" });
    assert.deepEqual(capView({ used: 135, limit: 150, raised: false }), { kind: "near", used: 135, limit: 150, raiseTo: 300 });
    assert.deepEqual(capView({ used: 150, limit: 150, raised: false }), { kind: "full", used: 150, limit: 150, raiseTo: 300 });
    assert.deepEqual(capView({ used: 150, limit: 300, raised: true }), { kind: "raised", used: 150, limit: 300 });
    assert.deepEqual(capView({ used: 300, limit: 300, raised: true }), { kind: "raised", used: 300, limit: 300 });
  });

  it("has calm copy", () => {
    assert.equal(capHeadline({ kind: "full", used: 150, limit: 150, raiseTo: 300 }), "This reading is full (150 students)");
    assert.equal(capHeadline({ kind: "near", used: 140, limit: 150, raiseTo: 300 }), "This reading is almost full (140 of 150 students)");
    assert.equal(capHeadline({ kind: "raised", used: 151, limit: 300 }), "Limit raised to 300 students");
    assert.equal(capRaisedMessage(300), "Limit raised to 300 students.");
    assert.equal(capAlreadyRaisedMessage(300), "The limit was already raised to 300 students.");
  });
});
