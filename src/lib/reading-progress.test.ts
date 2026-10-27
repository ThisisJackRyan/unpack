import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerStage,
  passedCountLabel,
  progressStatements,
  readingListItems,
  readingListStatement,
  readingProgress,
  stageAnnouncement,
  STUDENT_READING_STATUS_LABELS,
  studentReadingStatus,
  type AttemptView,
} from "./reading-progress";

const fail = (tryNumber: number): AttemptView => ({
  tryNumber,
  result: "fail",
  answers: { q1: { text: "a", pass: true, nudge: "" }, q2: { text: "idk", pass: false, nudge: "Look again." } },
});
const pass = (tryNumber: number): AttemptView => ({
  tryNumber,
  result: "pass",
  answers: { q1: { text: "a", pass: true, nudge: "" }, q2: { text: "b", pass: true, nudge: "" } },
});

describe("studentReadingStatus", () => {
  it("derives the status from attempts and the challenge", () => {
    assert.equal(studentReadingStatus({ passed: false, tries: 0, challenge: null }), "not_started");
    assert.equal(studentReadingStatus({ passed: false, tries: 1, challenge: null }), "in_progress");
    assert.equal(studentReadingStatus({ passed: false, tries: 3, challenge: null }), "in_progress");
    assert.equal(studentReadingStatus({ passed: true, tries: 2, challenge: null }), "passed");
    assert.equal(studentReadingStatus({ passed: false, tries: 3, challenge: "open" }), "challenged");
    assert.equal(studentReadingStatus({ passed: false, tries: 3, challenge: "approved" }), "passed");
    assert.equal(studentReadingStatus({ passed: false, tries: 3, challenge: "denied" }), "in_progress");
  });

  it("has a label for each", () => {
    assert.deepEqual(Object.values(STUDENT_READING_STATUS_LABELS), ["Not started", "In progress", "Passed", "Challenged"]);
  });
});

describe("answerStage", () => {
  it("starts at try 1, then prefills from the last failed try", () => {
    assert.deepEqual(answerStage({ attempts: [], challenge: null }), { kind: "answer", tryNumber: 1, previous: null });
    const one = fail(1);
    assert.deepEqual(answerStage({ attempts: [one], challenge: null }), { kind: "answer", tryNumber: 2, previous: one });
  });

  it("shows the passing try as done", () => {
    const p = pass(2);
    assert.deepEqual(answerStage({ attempts: [fail(1), p], challenge: null }), { kind: "passed", attempt: p, byTeacher: false });
  });

  it("offers the challenge after 3 failed tries", () => {
    const last = fail(3);
    assert.deepEqual(answerStage({ attempts: [fail(1), fail(2), last], challenge: null }), { kind: "out_of_tries", attempt: last });
  });

  it("shows a sent, denied, or approved challenge", () => {
    const attempts = [fail(1), fail(2), fail(3)];
    assert.equal(answerStage({ attempts, challenge: "open" }).kind, "challenged");
    assert.deepEqual(answerStage({ attempts, challenge: "denied" }), { kind: "challenged", status: "denied", attempt: attempts[2] });
    assert.deepEqual(answerStage({ attempts, challenge: "approved" }), { kind: "passed", attempt: attempts[2], byTeacher: true });
  });
});

describe("stageAnnouncement", () => {
  it("says what changed, and nothing before the first try", () => {
    assert.equal(stageAnnouncement({ kind: "answer", tryNumber: 1, previous: null }), "");
    assert.equal(
      stageAnnouncement({ kind: "answer", tryNumber: 2, previous: fail(1) }),
      "Not yet. 1 of 2 answers passed. Read the tips and try again. This is try 2 of 3.",
    );
    assert.match(stageAnnouncement({ kind: "passed", attempt: pass(1), byTeacher: false }), /You passed/);
    assert.match(stageAnnouncement({ kind: "out_of_tries", attempt: null }), /try 3 of 3/);
    assert.match(stageAnnouncement({ kind: "challenged", status: "open", attempt: null }), /Your teacher will take a look/);
  });

  it("counts passed answers", () => {
    assert.equal(passedCountLabel(pass(1)), "2 of 2 answers passed.");
    assert.equal(passedCountLabel({ tryNumber: 1, result: "fail", answers: { q: { text: "", pass: false, nudge: "x" } } }), "0 of 1 answer passed.");
  });
});

describe("readingProgress", () => {
  it("reads attempts with their answers, and the challenge", () => {
    const progress = readingProgress([
      [
        { try_number: 1, result: "fail", answers: [{ question_id: "q1", text: "idk", pass: false, nudge: "Look again." }] },
        { try_number: 2, result: "pass", answers: JSON.stringify([{ question_id: "q1", text: "b", pass: true, nudge: null }]) },
      ],
      [{ status: "open" }],
    ]);
    assert.deepEqual(progress, {
      attempts: [
        { tryNumber: 1, result: "fail", answers: { q1: { text: "idk", pass: false, nudge: "Look again." } } },
        { tryNumber: 2, result: "pass", answers: { q1: { text: "b", pass: true, nudge: "" } } },
      ],
      challenge: "open",
    });
    assert.deepEqual(readingProgress([[], []]), { attempts: [], challenge: null });
  });

  it("scopes the queries to the student and reading", () => {
    const [attempts, challenge] = progressStatements("s1", "r1");
    assert.match(attempts.text, /where a\.student_id = \$1::uuid and a\.reading_id = \$2::uuid/);
    assert.match(attempts.text, /order by a\.try_number/);
    assert.match(challenge.text, /from challenges where student_id = \$1::uuid and reading_id = \$2::uuid/);
  });
});

describe("readingListItems", () => {
  it("lists published readings in the class with each status", () => {
    const s = readingListStatement("c1", "s1");
    assert.match(s.text, /where r\.class_id = \$1::uuid and r\.status = 'published'/);
    assert.deepEqual(s.params, ["c1", "s1"]);
    const items = readingListItems([
      { id: "r1", title: "A", question_count: 3, passed: false, tries: 0, challenge: null },
      { id: "r2", title: "B", question_count: 2, passed: true, tries: 2, challenge: null },
      { id: "r3", title: "C", question_count: 1, passed: false, tries: 3, challenge: "open" },
      { id: "r4", title: "D", question_count: 1, passed: false, tries: 1, challenge: null },
    ]);
    assert.deepEqual(items.map((i) => i.status), ["not_started", "passed", "challenged", "in_progress"]);
    assert.deepEqual(items[0], { id: "r1", title: "A", questionCount: 3, status: "not_started" });
  });
});
