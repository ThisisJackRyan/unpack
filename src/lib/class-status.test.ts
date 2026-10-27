import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cellKey,
  classStatus,
  classStatusStatements,
  NOT_STARTED_CELL,
  statusCounts,
  studentDisplayName,
  triesLabel,
} from "./class-status";
import { EFFORT_CHECK_LIMIT, MAX_TRIES } from "./validate-answers";
import { STUDENT_GENERATION_CALL_LIMIT } from "./student-questions-core";

describe("classStatusStatements", () => {
  it("scopes every query to the class and its owning teacher", () => {
    const statements = classStatusStatements("c1", "t1");
    assert.equal(statements.length, 3);
    for (const s of statements) {
      assert.match(s.text, /c\.id = \$1::uuid and c\.teacher_id = \$2::uuid/);
      assert.deepEqual(s.params.slice(0, 2), ["c1", "t1"]);
    }
    assert.deepEqual(statements[2].params, ["c1", "t1", STUDENT_GENERATION_CALL_LIMIT]);
    assert.match(statements[0].text, /r\.status = 'published'/);
    assert.match(statements[2].text, /join readings r on r\.class_id = c\.id and r\.status = 'published'/);
    assert.match(
      statements[2].text,
      /r\.question_mode = 'per_student'\s+and not exists \(select 1 from questions q[\s\S]*g\.status = 'pending'[\s\S]*from student_question_calls k where k\.reading_id = r\.id and k\.student_id = s\.id\) >= \$3::int\s+\) as needs_reset/,
    );
    assert.match(statements[2].text, /left join lateral \(select lc\.status, lc\.tries_allowed is not null as extra_try[\s\S]*order by lc\.round desc limit 1\) lc on true/);
  });
});

describe("classStatus", () => {
  const status = classStatus([
    [
      { id: "r1", title: "Foxes" },
      { id: "r2", title: "Rivers" },
    ],
    [
      { id: "s1", first_name: "Maya", last_initials: "Ro" },
      { id: "s2", first_name: "ʻIolani", last_initials: "K" },
      { id: "s3", first_name: "Zoë", last_initials: "A" },
    ],
    [
      { student_id: "s1", reading_id: "r1", passed: true, tries: 2, checks: 2, challenge: null },
      { student_id: "s1", reading_id: "r2", passed: false, tries: 3, checks: 3, challenge: "open" },
      { student_id: "s2", reading_id: "r1", passed: false, tries: 3, checks: 3, challenge: "denied", extra_try: false },
      { student_id: "s2", reading_id: "r2", passed: false, tries: 3, checks: 3, challenge: "denied", extra_try: true, tries_allowed: 4, checks_allowed: 5 },
      { student_id: "s3", reading_id: "r1", passed: false, tries: 3, checks: 3, challenge: "approved" },
      { student_id: "s3", reading_id: "r2", passed: false, tries: 0, checks: 0, challenge: null, needs_reset: true },
    ],
  ]);

  it("derives each cell with the shared status rule and the student's limits", () => {
    const at = (s: string, r: string) => status.cells[cellKey(s, r)];
    assert.equal(at("s1", "r1").status, "passed");
    assert.equal(at("s1", "r2").status, "challenged");
    assert.equal(at("s2", "r1").status, "challenge_denied");
    assert.deepEqual(at("s2", "r2"), { status: "in_progress", tries: 3, triesAllowed: 4, checks: 3, checksAllowed: 5, needsReset: false });
    assert.equal(at("s3", "r1").status, "passed");
    assert.equal(at("s3", "r2").status, "not_started");
    assert.equal(at("s3", "r2").needsReset, true);
    assert.equal(at("s1", "r1").needsReset, false);
    assert.equal(triesLabel(at("s2", "r2")), "3 of 4 tries");
    assert.equal(triesLabel({ ...NOT_STARTED_CELL, triesAllowed: 1, tries: 1 }), "1 of 1 try");
  });

  it("names students as first name plus initials", () => {
    assert.deepEqual(status.students.map((s) => s.name), ["Maya Ro", "ʻIolani K", "Zoë A"]);
    assert.equal(studentDisplayName("Maya", null), "Maya");
  });

  it("counts statuses per reading, a missing cell as Not started", () => {
    assert.deepEqual(statusCounts(status, "r1"), { not_started: 0, in_progress: 0, passed: 2, challenged: 0, challenge_denied: 1 });
    assert.deepEqual(statusCounts({ ...status, cells: {} }, "r1").not_started, 3);
    assert.deepEqual(NOT_STARTED_CELL, { status: "not_started", tries: 0, triesAllowed: MAX_TRIES, checks: 0, checksAllowed: EFFORT_CHECK_LIMIT, needsReset: false });
  });
});
